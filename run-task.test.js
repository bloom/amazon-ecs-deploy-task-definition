const run = require('./index');
const core = require('@actions/core');
const { ECS, waitUntilTasksStopped } = require('@aws-sdk/client-ecs');
const fs = require('fs');

jest.mock('@actions/core');
jest.mock('@aws-sdk/client-ecs');
jest.mock('@aws-sdk/client-codedeploy');
jest.mock('fs', () => ({ promises: { access: jest.fn() }, readFileSync: jest.fn() }));

const taskArn = 'arn:aws:ecs:us-east-1:123456789012:task/test/expected';
const definitionArn = 'arn:aws:ecs:us-east-1:123456789012:task-definition/test:1';
const definition = {
    family: 'test',
    containerDefinitions: [{ name: 'migration' }, { name: 'sidecar', essential: false }]
};

function stoppedTask() {
    return {
        taskArn,
        taskDefinitionArn: definitionArn,
        lastStatus: 'STOPPED',
        stopCode: 'EssentialContainerExited',
        containers: ['migration', 'sidecar'].map(name => ({
            name, lastStatus: 'STOPPED', exitCode: 0
        }))
    };
}

const ecs = {
    config: { region: async () => 'us-east-1' },
    registerTaskDefinition: jest.fn(),
    runTask: jest.fn(),
    describeTasks: jest.fn(),
    describeServices: jest.fn(),
    updateService: jest.fn()
};

beforeEach(() => {
    jest.resetAllMocks();
    process.env.GITHUB_WORKSPACE = __dirname;
    const inputs = {
        'task-definition': 'task-definition.json',
        cluster: 'test',
        service: 'test-service',
        'run-task': 'true',
        'wait-for-task-stopped': 'true'
    };
    core.getInput.mockImplementation(name => inputs[name] || '');
    fs.readFileSync.mockReturnValue(JSON.stringify(definition));
    ECS.mockImplementation(() => ecs);
    ecs.registerTaskDefinition.mockResolvedValue({ taskDefinition: { taskDefinitionArn: definitionArn } });
    ecs.runTask.mockResolvedValue({ tasks: [{ taskArn, taskDefinitionArn: definitionArn }] });
    ecs.describeTasks.mockResolvedValue({ tasks: [stoppedTask()], failures: [] });
    ecs.describeServices.mockResolvedValue({ services: [{ status: 'ACTIVE' }] });
    ecs.updateService.mockResolvedValue({});
    waitUntilTasksStopped.mockResolvedValue({ state: 'SUCCESS' });
});

function expectNoServiceUpdate() {
    expect(ecs.describeServices).not.toHaveBeenCalled();
    expect(ecs.updateService).not.toHaveBeenCalled();
}

const invalidResults = [
    ['no returned tasks', () => ({ tasks: [] }), /expected task/i],
    ['missing tasks field', () => ({}), /expected task/i],
    ['lookup failure with no tasks', () => ({ tasks: [], failures: [{ arn: taskArn, reason: 'MISSING' }] }), /MISSING/],
    ['lookup failure despite a returned task', () => ({ tasks: [stoppedTask()], failures: [{ arn: taskArn, reason: 'MISSING' }] }), /MISSING/],
    ['wrong task identity', () => ({ tasks: [{ ...stoppedTask(), taskArn: 'other-task' }] }), /expected task/i],
    ['duplicate task identity', () => ({ tasks: [stoppedTask(), stoppedTask()] }), /expected task/i],
    ['missing task identity', () => { const task = stoppedTask(); delete task.taskArn; return { tasks: [task] }; }, /expected task/i],
    ['wrong task definition', () => ({ tasks: [{ ...stoppedTask(), taskDefinitionArn: 'other-definition' }] }), /task definition/i],
    ['missing task definition', () => { const task = stoppedTask(); delete task.taskDefinitionArn; return { tasks: [task] }; }, /task definition/i],
    ['task still running', () => ({ tasks: [{ ...stoppedTask(), lastStatus: 'RUNNING' }] }), /STOPPED/],
    ['task without a status', () => { const task = stoppedTask(); delete task.lastStatus; return { tasks: [task] }; }, /STOPPED/],
    ['abnormal task stop', () => ({ tasks: [{ ...stoppedTask(), stopCode: 'TaskFailedToStart' }] }), /TaskFailedToStart/],
    ['manual task stop', () => ({ tasks: [{ ...stoppedTask(), stopCode: 'UserInitiated' }] }), /UserInitiated/],
    ['missing stop code', () => { const task = stoppedTask(); delete task.stopCode; return { tasks: [task] }; }, /stop code/i],
    ['no containers', () => ({ tasks: [{ ...stoppedTask(), containers: [] }] }), /expected container/i],
    ['missing containers field', () => { const task = stoppedTask(); delete task.containers; return { tasks: [task] }; }, /expected container/i],
    ['only a successful sidecar', () => { const task = stoppedTask(); task.containers.shift(); return { tasks: [task] }; }, /expected container/i],
    ['missing sidecar', () => { const task = stoppedTask(); task.containers.pop(); return { tasks: [task] }; }, /expected container/i],
    ['duplicate container name', () => { const task = stoppedTask(); task.containers[1].name = 'migration'; return { tasks: [task] }; }, /expected container/i],
    ['unexpected container', () => { const task = stoppedTask(); task.containers[1].name = 'other'; return { tasks: [task] }; }, /expected container/i],
    ['container still running', () => { const task = stoppedTask(); task.containers[0].lastStatus = 'RUNNING'; return { tasks: [task] }; }, /migration.*STOPPED/],
    ['missing container status', () => { const task = stoppedTask(); delete task.containers[0].lastStatus; return { tasks: [task] }; }, /migration.*STOPPED/],
    ['missing migration exit code', () => { const task = stoppedTask(); delete task.containers[0].exitCode; return { tasks: [task] }; }, /migration.*exit code/i],
    ['nonzero migration exit', () => { const task = stoppedTask(); task.containers[0].exitCode = 1; return { tasks: [task] }; }, /migration.*exit code.*1/i],
    ['nonzero sidecar exit', () => { const task = stoppedTask(); task.containers[1].exitCode = 137; return { tasks: [task] }; }, /sidecar.*exit code.*137/i],
    ['string exit code', () => { const task = stoppedTask(); task.containers[0].exitCode = '0'; return { tasks: [task] }; }, /migration.*exit code/i],
    ['null exit code', () => { const task = stoppedTask(); task.containers[0].exitCode = null; return { tasks: [task] }; }, /migration.*exit code/i]
];

describe('waited task result validation', () => {
    test.each(invalidResults)('rejects %s before service deployment', async (_name, response, message) => {
        ecs.describeTasks.mockResolvedValue(response());
        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(1);
        expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(message));
        expectNoServiceUpdate();
    });

    test('updates the service only after all expected containers exit successfully', async () => {
        await run();
        expect(core.setFailed).not.toHaveBeenCalled();
        expect(ecs.describeTasks).toHaveBeenCalledWith({ cluster: 'test', tasks: [taskArn] });
        expect(ecs.updateService).toHaveBeenCalledTimes(1);
        expect(waitUntilTasksStopped.mock.invocationCallOrder[0]).toBeLessThan(ecs.describeTasks.mock.invocationCallOrder[0]);
        expect(ecs.describeTasks.mock.invocationCallOrder[0]).toBeLessThan(ecs.updateService.mock.invocationCallOrder[0]);
    });

    test('accepts reordered containers by name', async () => {
        const task = stoppedTask();
        task.containers.reverse();
        ecs.describeTasks.mockResolvedValue({ tasks: [task] });
        await run();
        expect(core.setFailed).not.toHaveBeenCalled();
        expect(ecs.updateService).toHaveBeenCalledTimes(1);
    });

    test('supports a task definition with one container', async () => {
        fs.readFileSync.mockReturnValue(JSON.stringify({ ...definition, containerDefinitions: [{ name: 'migration' }] }));
        const task = stoppedTask();
        task.containers.pop();
        ecs.describeTasks.mockResolvedValue({ tasks: [task] });
        await run();
        expect(core.setFailed).not.toHaveBeenCalled();
        expect(ecs.updateService).toHaveBeenCalledTimes(1);
    });

    test('does not update a service after a waiter failure', async () => {
        waitUntilTasksStopped.mockRejectedValue(new Error('waiter timeout'));
        await run();
        expect(core.setFailed).toHaveBeenCalledWith('waiter timeout');
        expect(ecs.describeTasks).not.toHaveBeenCalled();
        expectNoServiceUpdate();
    });

    test('does not update a service after a task lookup exception', async () => {
        ecs.describeTasks.mockRejectedValue(new Error('lookup unavailable'));
        await run();
        expect(core.setFailed).toHaveBeenCalledWith('lookup unavailable');
        expectNoServiceUpdate();
    });

    test('preserves no-wait behavior', async () => {
        const getInput = core.getInput.getMockImplementation();
        core.getInput.mockImplementation(name => name === 'wait-for-task-stopped' ? 'false' : getInput(name));
        await run();
        expect(core.setFailed).not.toHaveBeenCalled();
        expect(waitUntilTasksStopped).not.toHaveBeenCalled();
        expect(ecs.describeTasks).not.toHaveBeenCalled();
        expect(ecs.updateService).toHaveBeenCalledTimes(1);
    });
});

describe('task container definitions', () => {
    test.each([
        ['missing definitions', undefined],
        ['empty definitions', []],
        ['missing name', [{}]],
        ['empty name', [{ name: '' }]],
        ['duplicate names', [{ name: 'migration' }, { name: 'migration' }]]
    ])('rejects %s before task launch', async (_name, containerDefinitions) => {
        fs.readFileSync.mockReturnValue(JSON.stringify({ ...definition, containerDefinitions }));
        await run();
        expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/container definitions/i));
        expect(ecs.runTask).not.toHaveBeenCalled();
        expectNoServiceUpdate();
    });
});

describe('task launch result validation', () => {
    test.each([
        ['no tasks', { tasks: [] }, /exactly one task/i],
        ['missing tasks', {}, /exactly one task/i],
        ['missing ARN', { tasks: [{}] }, /task ARN/i],
        ['empty ARN', { tasks: [{ taskArn: '' }] }, /task ARN/i],
        ['multiple tasks', { tasks: [{ taskArn }, { taskArn: 'other' }] }, /exactly one task/i],
        ['wrong definition', { tasks: [{ taskArn, taskDefinitionArn: 'other-definition' }] }, /task definition/i],
        ['missing definition', { tasks: [{ taskArn }] }, /task definition/i],
        ['reported failure', { tasks: [], failures: [{ arn: taskArn, reason: 'RESOURCE:MEMORY' }] }, /RESOURCE:MEMORY/]
    ])('rejects %s before the waiter or service deployment', async (_name, response, message) => {
        ecs.runTask.mockResolvedValue(response);
        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(1);
        expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(message));
        expect(waitUntilTasksStopped).not.toHaveBeenCalled();
        expectNoServiceUpdate();
    });
});
