/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as path from 'path'

import { collectFiles } from '../../files'
import {
    FileMetadata,
    GenerateApproachInput,
    GenerateApproachOutput,
    GenerateCodeInput,
    GenerateCodeOutput,
    GetCodeGenerationResultInput,
    GetCodeGenerationResultOutput,
    IterateApproachInput,
    IterateApproachOutput,
} from '../../client/weaverbirdclient'
import { getLogger } from '../../../shared/logger'
import { FileSystemCommon } from '../../../srcShared/fs'
import { VirtualFileSystem } from '../../../shared/virtualFilesystem'
import { VirtualMemoryFile } from '../../../shared/virtualMemoryFile'
import { weaverbirdScheme } from '../../constants'
import type {
    Interaction,
    SessionStateAction,
    SessionStateConfig,
    SessionStateInteraction,
    SessionState,
    NewFileContents,
} from '../../types'
import { invoke } from './invoke'

const fs = FileSystemCommon.instance

export class RefinementState implements SessionState {
    public tokenSource: vscode.CancellationTokenSource

    constructor(private config: Omit<SessionStateConfig, 'conversationId'>, public approach: string) {
        this.tokenSource = new vscode.CancellationTokenSource()
    }

    async interact(action: SessionStateAction): Promise<SessionStateInteraction> {
        const payload = {
            task: action.task,
            originalFileContents: action.files,
            config: this.config.llmConfig,
        }

        const response = await invoke<GenerateApproachInput, GenerateApproachOutput>(
            this.config.client,
            this.config.backendConfig.lambdaArns.approach.generate,
            payload
        )

        this.approach =
            response.approach ?? "There has been a problem generating an approach. Please type 'CLEAR' and start over."

        return {
            nextState: new RefinementIterationState(
                {
                    ...this.config,
                    conversationId: response.conversationId,
                },
                this.approach
            ),
            interactions: [
                {
                    origin: 'ai',
                    type: 'message',
                    content: `${this.approach}\n`,
                },
            ],
        }
    }
}

export class RefinementIterationState implements SessionState {
    public tokenSource: vscode.CancellationTokenSource

    constructor(private config: SessionStateConfig, public approach: string) {
        this.tokenSource = new vscode.CancellationTokenSource()
    }

    async interact(action: SessionStateAction): Promise<SessionStateInteraction> {
        if (action.msg && action.msg.indexOf('WRITE CODE') !== -1) {
            return new CodeGenState(this.config, this.approach).interact(action)
        }

        if (action.msg && action.msg.indexOf('MOCK CODE') !== -1) {
            return new MockCodeGenState(this.config, this.approach).interact(action)
        }

        const payload: IterateApproachInput = {
            task: action.task,
            request: action.msg ?? '',
            approach: this.approach,
            originalFileContents: action.files,
            config: this.config.llmConfig,
            conversationId: this.config.conversationId,
        }

        const response = await invoke<IterateApproachInput, IterateApproachOutput>(
            this.config.client,
            this.config.backendConfig.lambdaArns.approach.iterate,
            payload
        )

        this.approach =
            response.approach ?? "There has been a problem generating an approach. Please type 'CLEAR' and start over."

        return {
            nextState: new RefinementIterationState(this.config, this.approach),
            interactions: [
                {
                    origin: 'ai',
                    type: 'message',
                    content: `${this.approach}\n`,
                },
            ],
        }
    }
}

async function createChanges(fs: VirtualFileSystem, newFileContents: NewFileContents): Promise<Interaction[]> {
    const filePaths: string[] = []
    for (const { filePath, fileContent } of newFileContents) {
        const encoder = new TextEncoder()
        const contents = encoder.encode(fileContent)
        const uri = vscode.Uri.from({ scheme: weaverbirdScheme, path: filePath })
        fs.registerProvider(uri, new VirtualMemoryFile(contents))
        filePaths.push(filePath)
    }

    return [
        {
            origin: 'ai',
            type: 'message',
            content: 'Changes to files done. Please review:',
        },
        {
            origin: 'ai',
            type: 'codegen',
            content: filePaths,
        },
    ]
}

abstract class CodeGenBase {
    private pollCount = 60
    tokenSource: vscode.CancellationTokenSource

    constructor(protected config: SessionStateConfig) {
        this.tokenSource = new vscode.CancellationTokenSource()
    }

    async generateCode(params: {
        getResultLambdaArn: string
        fs: VirtualFileSystem
        onAddToHistory: vscode.EventEmitter<Interaction[]>
        generationId: string
    }) {
        for (
            let pollingIteration = 0;
            pollingIteration < this.pollCount && !this.tokenSource.token.isCancellationRequested;
            ++pollingIteration
        ) {
            const payload: GetCodeGenerationResultInput = {
                generationId: params.generationId,
                conversationId: this.config.conversationId,
            }

            const codegenResult = await invoke<GetCodeGenerationResultInput, GetCodeGenerationResultOutput>(
                this.config.client,
                params.getResultLambdaArn,
                payload
            )
            getLogger().info(`Codegen response: ${JSON.stringify(codegenResult)}`)

            switch (codegenResult.codeGenerationStatus) {
                case 'ready': {
                    const newFiles = codegenResult.result?.newFileContents ?? []
                    const changes = await createChanges(params.fs, newFiles)
                    params.onAddToHistory.fire(changes)
                    return newFiles
                }
                case 'in-progress': {
                    await new Promise(f => setTimeout(f, 10000))
                    break
                }
                case 'failed': {
                    getLogger().error('Failed to generate code')
                    params.onAddToHistory.fire([
                        {
                            origin: 'ai',
                            type: 'message',
                            content: 'Code generation failed\n',
                        },
                    ])
                    return []
                }
                default: {
                    const errorMessage = `Unknown status: ${codegenResult.codeGenerationStatus}\n`
                    getLogger().error(errorMessage)
                    params.onAddToHistory.fire([
                        {
                            origin: 'ai',
                            type: 'message',
                            content: errorMessage,
                        },
                    ])
                    return []
                }
            }
        }
        // still in progress
        const errorMessage = `Code generation did not finish withing the expected time :(`
        getLogger().error(errorMessage)
        params.onAddToHistory.fire([
            {
                origin: 'ai',
                type: 'message',
                content: errorMessage,
            },
        ])
        return []
    }
}

export class CodeGenState extends CodeGenBase implements SessionState {
    constructor(config: SessionStateConfig, public approach: string) {
        super(config)
    }

    async interact(action: SessionStateAction): Promise<SessionStateInteraction> {
        const payload: GenerateCodeInput = {
            originalFileContents: action.files,
            approach: this.approach,
            task: action.task,
            config: this.config.llmConfig,
            conversationId: this.config.conversationId,
        }

        const response = await invoke<GenerateCodeInput, GenerateCodeOutput>(
            this.config.client,
            this.config.backendConfig.lambdaArns.codegen.generate,
            payload
        )

        const genId = response.generationId

        action.onAddToHistory.fire([
            {
                origin: 'ai',
                type: 'message',
                content: 'Code generation started\n',
            },
        ])

        const newFileContents = await this.generateCode({
            getResultLambdaArn: this.config.backendConfig.lambdaArns.codegen.getResults,
            fs: action.fs,
            onAddToHistory: action.onAddToHistory,
            generationId: genId,
        }).catch(_ => {
            getLogger().error(`Failed to generate code`)
            return []
        })

        const nextState = new CodeGenIterationState(this.config, this.approach, newFileContents)

        return {
            nextState,
            interactions: [],
        }
    }
}

export class MockCodeGenState implements SessionState {
    public tokenSource: vscode.CancellationTokenSource

    constructor(private config: SessionStateConfig, public approach: string) {
        this.tokenSource = new vscode.CancellationTokenSource()
    }

    async interact(action: SessionStateAction): Promise<SessionStateInteraction> {
        let newFileContents: NewFileContents = []

        // in a `mockcodegen` state, we should read from the `mock-data` folder and output
        // every file retrieved in the same shape the LLM would
        const mockedFilesDir = path.join(this.config.workspaceRoot, './mock-data')
        try {
            const mockDirectoryExists = await fs.stat(mockedFilesDir)
            if (mockDirectoryExists) {
                const files = await collectFiles(mockedFilesDir)
                newFileContents = files.map(f => ({
                    filePath: f.filePath.replace('mock-data/', ''),
                    fileContent: f.fileContent,
                }))
            }
        } catch (e) {
            // TODO: handle this error properly, double check what would be expected behaviour if mock code does not work.
            getLogger().error('Unable to use mock code generation: %O', e)
        }

        return {
            nextState: new CodeGenIterationState(this.config, this.approach, newFileContents),
            interactions: await createChanges(action.fs, newFileContents),
        }
    }
}

export class CodeGenIterationState extends CodeGenBase implements SessionState {
    constructor(config: SessionStateConfig, public approach: string, private newFileContents: FileMetadata[]) {
        super(config)
    }

    async interact(action: SessionStateAction): Promise<SessionStateInteraction> {
        const fileContents = [...this.newFileContents].concat(
            ...action.files.filter(
                originalFile => !this.newFileContents.some(newFile => newFile.filePath === originalFile.filePath)
            )
        )
        const payload: GenerateCodeInput = {
            originalFileContents: fileContents,
            approach: this.approach,
            task: action.task,
            //comment: action.msg ?? '',
            config: this.config.llmConfig,
            conversationId: this.config.conversationId,
        }

        const response = await invoke<GenerateCodeInput, GenerateCodeOutput>(
            this.config.client,
            // going to the `generate` lambda here because the `iterate` one doesn't work on a
            // task/poll-results strategy yet
            this.config.backendConfig.lambdaArns.codegen.generate,
            payload
        )

        const genId = response.generationId

        action.onAddToHistory.fire([
            {
                origin: 'ai',
                type: 'message',
                content: 'Code generation started\n',
            },
        ])

        this.newFileContents = await this.generateCode({
            getResultLambdaArn: this.config.backendConfig.lambdaArns.codegen.getResults,
            fs: action.fs,
            onAddToHistory: action.onAddToHistory,
            generationId: genId,
        }).catch(_ => {
            getLogger().error(`Failed to generate code`)
            return []
        })

        return {
            nextState: this,
            interactions: [{ origin: 'ai', type: 'message', content: 'Changes to files done' }],
        }
    }
}
