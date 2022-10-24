import { promises as fs, constants as FsConstants } from 'fs';
import path from 'path';

import { StateTypeExecutor } from '../StateTypeExecutor';
import type { StateExecutorOutput } from '../../types/StateExecutorOutput';
import type { TaskStateDefinition } from '../../types/State';

import { StateInfoHandler } from '../../StateInfoHandler';
import { StateProcessor } from '../../StateProcessor';
import { Context } from '../../Context/Context';
import { Retriers } from '../../types/Retriers';
import { Catchers } from '../../types/Catchers';
import { StatesErrors } from '../../types/StatesErrors';

export class TaskExecutor extends StateTypeExecutor {
  public async execute(
    context: Context,
    stateDefinition: TaskStateDefinition,
    inputJson: string | undefined,
  ): Promise<StateExecutorOutput> {
    const statesInfoHandler = StateInfoHandler.getInstance();
    const stateInfo = statesInfoHandler.getStateInfo(context.StateMachine.Name, context.State.Name);

    if (!stateInfo) {
      throw new Error('Handler does not exists');
    }

    const input = this.processInput(inputJson, stateDefinition, context);
    const lambdaPath = await this.getWebpackOrCommonFuction(stateInfo.handlerPath);
    const functionLambda = await import(`${lambdaPath}`);
    let exec_output, exec_error;
    this.envVarResolver.injectEnvVarsLambdaSpecific(stateInfo.environment);
    const callback = (err, res) => {
      exec_output = res;
      exec_error = err;
    };
    try {
      if (stateDefinition.Retry) {
        const retries = Retriers.create(stateDefinition.Retry);
        await retries.retry(() => functionLambda[stateInfo.handlerName](input, context, callback), context);
      } else {
        await functionLambda[stateInfo.handlerName](input, context, callback);
        console.log(`the result is:${exec_output}`);
      }
      if (exec_error) {
        throw exec_error;
      }
    } catch (error) {
      this.envVarResolver.removeEnvVarsLambdaSpecific(stateInfo.environment);

      return this.dealWithError(stateDefinition, error, input);
    }

    // Default ot Empty object if exec_output is from a void function
    if (exec_output === undefined) {
      exec_output = {};
    }

    this.envVarResolver.removeEnvVarsLambdaSpecific(stateInfo.environment);

    const outputJson = this.processOutput(JSON.parse(inputJson || '{}'), exec_output, stateDefinition);

    return {
      Next: stateDefinition.Next,
      End: stateDefinition.End,
      json: outputJson,
    };
  }

  public isWaitForTaskToken(resource?: string): boolean {
    if (resource && typeof resource === 'string' && resource.endsWith('.waitForTaskToken')) {
      return true;
    }
    return false;
  }

  private dealWithError(stateDefinition: TaskStateDefinition, error: Error, input: Record<string, unknown>) {
    if (!stateDefinition.Catch) {
      throw error;
    }

    this.logger.error(`Caught an error in Catcher: ${error.stack}`);

    const catchers = Catchers.create(stateDefinition.Catch);
    const catcher = catchers.getCatcherBasedOn([StatesErrors.TaskFailed, StatesErrors.All]);

    if (!catcher) {
      throw error;
    }

    const output = { message: error.message, stack: error.stack };
    const outputJson = StateProcessor.processResultPath(input, output, catcher.ResultPath);
    this.logger.log(`Using Next state of Catcher: ${catcher.Next}`);

    return {
      Next: catcher.Next,
      End: stateDefinition.End,
      json: outputJson,
    };
  }

  private processInput(
    json: string | undefined,
    stateDefinition: TaskStateDefinition,
    context: Context,
  ): StateExecutorOutput {
    this.logger.debug(`TaskExecutor - processInput1 - ${json}`);
    this.logger.debug(JSON.stringify(stateDefinition));
    const proccessedInputJson = StateProcessor.processInputPath(json, stateDefinition.InputPath);
    this.logger.debug(`TaskExecutor - processInput2 - ${proccessedInputJson}`);

    let output = proccessedInputJson;

    if (
      stateDefinition.Parameters &&
      typeof stateDefinition.Resource === 'string' &&
      stateDefinition.Resource.endsWith('.waitForTaskToken')
    ) {
      output = StateProcessor.processWaitForTokenParameters(proccessedInputJson, stateDefinition.Parameters, context);
    } else {
      output = StateProcessor.processParameters(proccessedInputJson, stateDefinition.Parameters, context);
    }

    try {
      return JSON.parse(output);
    } catch (error) {
      this.logger.error(`TaskExecutor.processInput: Could not parse JSON for state ${context.State.Name}: "${output}"`);
      throw error;
    }
  }

  private processOutput(
    input: Record<string, unknown>,
    output: Record<string, unknown> | unknown[],
    stateDefinition: TaskStateDefinition,
  ): string {
    this.logger.debug(`TaskExecutor - processOutput1 - ${JSON.stringify(output)}`);
    let outputJson = output ? JSON.stringify(output) : '{}';

    outputJson = StateProcessor.processResultSelector(outputJson, stateDefinition.ResultSelector);
    outputJson = StateProcessor.processResultPath(input, output, stateDefinition.ResultPath);
    this.logger.debug(`TaskExecutor - processOutput2 - ${outputJson}`);
    outputJson = StateProcessor.processOutputPath(outputJson, stateDefinition.OutputPath);
    this.logger.debug(`TaskExecutor - processOutput3 - ${outputJson}`);

    return outputJson;
  }

  private async getWebpackOrCommonFuction(lambdaFilePath: string): Promise<string> {
    const webpackPath = path.resolve(process.cwd(), `./.webpack/service/${lambdaFilePath}.js`);
    let filePathResolved: string;

    try {
      await fs.access(webpackPath, FsConstants.F_OK | FsConstants.R_OK);
      filePathResolved = webpackPath;
    } catch (error) {
      filePathResolved = path.resolve(process.cwd(), `./.build/${lambdaFilePath}.js`);
    }

    return filePathResolved;
  }
}
