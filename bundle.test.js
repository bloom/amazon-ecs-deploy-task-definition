const http = require('http');
const { spawn } = require('child_process');
const { mkdtemp, writeFile, readFile, rm } = require('fs/promises');
const { tmpdir } = require('os');
const path = require('path');

const taskArn = 'arn:aws:ecs:us-east-1:123456789012:task/test/expected';
const definitionArn = 'arn:aws:ecs:us-east-1:123456789012:task-definition/test:1';
const entrypoint = process.env.ECS_ACTION_ENTRYPOINT || path.join(__dirname, 'dist/index.js');

function stoppedTask() {
    return {
        taskArn,
        taskDefinitionArn: definitionArn,
        lastStatus: 'STOPPED',
        stopCode: 'EssentialContainerExited',
        containers: [{ name: 'migration', lastStatus: 'STOPPED', exitCode: 0 }]
    };
}

async function runBundle(finalResponse) {
    const directory = await mkdtemp(path.join(tmpdir(), 'ecs-action-test-'));
    const calls = [];
    let describes = 0;
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        const operation = request.headers['x-amz-target'].split('.').pop();
        calls.push({ operation, input: JSON.parse(body) });
        let output;
        switch (operation) {
        case 'RegisterTaskDefinition':
            output = { taskDefinition: { taskDefinitionArn: definitionArn } };
            break;
        case 'RunTask':
            output = { tasks: [{ taskArn, taskDefinitionArn: definitionArn }] };
            break;
        case 'DescribeTasks':
            // The SDK waiter receives a stopped task before the final result check.
            output = describes++ === 0 ? { tasks: [stoppedTask()] } : finalResponse;
            break;
        case 'DescribeServices':
            output = { services: [{ status: 'ACTIVE' }] };
            break;
        case 'UpdateService':
            output = { service: {} };
            break;
        default:
            response.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' });
            response.end(JSON.stringify({ message: `Unexpected operation ${operation}` }));
            return;
        }
        response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
        response.end(JSON.stringify(output));
    });
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const endpoint = `http://127.0.0.1:${server.address().port}`;
        await writeFile(path.join(directory, 'task.json'), JSON.stringify({
            family: 'test', containerDefinitions: [{ name: 'migration', essential: true }]
        }));
        await writeFile(path.join(directory, 'output'), '');
        const env = {
            PATH: process.env.PATH,
            HOME: directory,
            AWS_REGION: 'us-east-1',
            AWS_ACCESS_KEY_ID: 'synthetic-access-key',
            AWS_SECRET_ACCESS_KEY: 'synthetic-secret-key',
            AWS_EC2_METADATA_DISABLED: 'true',
            AWS_ENDPOINT_URL: endpoint,
            AWS_ENDPOINT_URL_ECS: endpoint,
            GITHUB_WORKSPACE: directory,
            GITHUB_OUTPUT: path.join(directory, 'output'),
            'INPUT_TASK-DEFINITION': 'task.json',
            INPUT_CLUSTER: 'test',
            INPUT_SERVICE: 'test-service',
            'INPUT_RUN-TASK': 'true',
            'INPUT_WAIT-FOR-TASK-STOPPED': 'true'
        };
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [entrypoint], {
                env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000
            });
            let output = '';
            child.stdout.on('data', data => { output += data; });
            child.stderr.on('data', data => { output += data; });
            child.on('error', reject);
            child.on('close', (code, signal) => resolve({ code, signal, output }));
        });
        return { ...result, calls, actionOutput: await readFile(path.join(directory, 'output'), 'utf8') };
    } finally {
        await new Promise(resolve => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
}

describe('packaged action with a local ECS endpoint', () => {
    test('validates the stopped task before it updates the service', async () => {
        const result = await runBundle({ tasks: [stoppedTask()] });
        expect(result.signal).toBeNull();
        expect(result.output).not.toContain('::error::');
        expect(result.code).toBe(0);
        expect(result.calls.map(call => call.operation)).toEqual([
            'RegisterTaskDefinition', 'RunTask', 'DescribeTasks', 'DescribeTasks', 'DescribeServices', 'UpdateService'
        ]);
        expect(result.actionOutput).toContain(taskArn);
        expect(result.calls.at(-1).input.taskDefinition).toBe(definitionArn);
    }, 15_000);

    test.each([
        ['empty tasks', { tasks: [] }, /expected task/],
        ['lookup failure', { tasks: [], failures: [{ arn: taskArn, reason: 'MISSING' }] }, /MISSING/],
        ['wrong task', { tasks: [{ ...stoppedTask(), taskArn: 'wrong-task' }] }, /expected task/],
        ['wrong definition', { tasks: [{ ...stoppedTask(), taskDefinitionArn: 'wrong-definition' }] }, /task definition/],
        ['no containers', { tasks: [{ ...stoppedTask(), containers: [] }] }, /expected containers/],
        ['only a sidecar', { tasks: [{ ...stoppedTask(), containers: [{ name: 'sidecar', lastStatus: 'STOPPED', exitCode: 0 }] }] }, /expected containers/],
        ['nonzero exit', { tasks: [{ ...stoppedTask(), containers: [{ name: 'migration', lastStatus: 'STOPPED', exitCode: 1 }] }] }, /exit code 1/],
        ['abnormal stop', { tasks: [{ ...stoppedTask(), stopCode: 'TaskFailedToStart' }] }, /TaskFailedToStart/]
    ])('rejects %s without a service update', async (_name, response, message) => {
        const result = await runBundle(response);
        expect(result.signal).toBeNull();
        expect(result.code).toBe(1);
        expect(result.output).toMatch(message);
        expect(result.calls.map(call => call.operation)).toEqual([
            'RegisterTaskDefinition', 'RunTask', 'DescribeTasks', 'DescribeTasks'
        ]);
    }, 15_000);
});
