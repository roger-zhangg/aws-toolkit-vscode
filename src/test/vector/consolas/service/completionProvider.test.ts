/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as vscode from 'vscode'

import { getCompletionItems, getCompletionItem, getLabel } from '../../../../vector/consolas/service/completionProvider'
import { createMockDocument, resetConsolasGlobalVariables } from '../testUtil'
import { recommendations } from '../../../../vector/consolas/models/model'
import { RecommendationDetail } from '../../../../vector/consolas/client/consolas'

describe('completionProviderService', function () {
    beforeEach(function () {
        resetConsolasGlobalVariables()
    })

    describe('getLabel', function () {
        it('should return correct label given recommendation longer than Constants.LABEL_LENGTH', function () {
            const mockLongRecommendation = `
            const metaDataFile = path.join(__dirname, 'nls.metadata.json');
            const locale = getUserDefinedLocale(argvConfig);`
            const expected = '\n            const m..'
            assert.strictEqual(getLabel(mockLongRecommendation), expected)
        })

        it('should return correct label given short recommendation', function () {
            const mockShortRecommendation = 'function onReady()'
            const expected = 'function onReady()..'
            assert.strictEqual(getLabel(mockShortRecommendation), expected)
        })
    })

    describe('getCompletionItem', function () {
        it('should return targetCompletionItem given input', function () {
            const mockPosition = new vscode.Position(0, 83)
            const mockRecommendationDetail: RecommendationDetail = {
                content: "\n\t\tconsole.log('Hello world!');\n\t}",
            }
            const mockRecommendationIndex = 1
            const mockDocument = createMockDocument('', 'test.ts', 'typescript')
            const expected: vscode.CompletionItem = {
                label: "\n\t\tconsole.log('Hell..",
                kind: 1,
                detail: 'AWS Consolas',
                documentation: new vscode.MarkdownString().appendCodeblock(
                    "\n\t\tconsole.log('Hello world!');\n\t}",
                    'typescript'
                ),
                sortText: '0000000002',
                preselect: true,
                insertText: new vscode.SnippetString("\n\t\tconsole.log('Hello world!');\n\t}"),
                keepWhitespace: true,
                command: {
                    command: 'aws.consolas.accept',
                    title: 'On acceptance',
                    arguments: [
                        new vscode.Range(0, 0, 0, 0),
                        1,
                        "\n\t\tconsole.log('Hello world!');\n\t}",
                        '',
                        'OnDemand',
                        'Line',
                        'javascript',
                        undefined,
                    ],
                },
            }
            const actual = getCompletionItem(
                mockDocument,
                mockPosition,
                mockRecommendationDetail,
                mockRecommendationIndex
            )
            assert.deepStrictEqual(actual.command, expected.command)
            assert.strictEqual(actual.sortText, expected.sortText)
            assert.strictEqual(actual.label, expected.label)
            assert.strictEqual(actual.kind, expected.kind)
            assert.strictEqual(actual.preselect, expected.preselect)
            assert.strictEqual(actual.keepWhitespace, expected.keepWhitespace)
            assert.strictEqual(JSON.stringify(actual.documentation), JSON.stringify(expected.documentation))
            assert.strictEqual(JSON.stringify(actual.insertText), JSON.stringify(expected.insertText))
        })
    })

    describe('getCompletionItems', function () {
        it('should return completion items for each non-empty recommendation', async function () {
            recommendations.response = [{ content: "\n\t\tconsole.log('Hello world!');\n\t}" }, { content: '' }]
            const mockPosition = new vscode.Position(0, 0)
            const mockDocument = createMockDocument('', 'test.ts', 'typescript')
            const actual = getCompletionItems(mockDocument, mockPosition)
            assert.strictEqual(actual.length, 1)
        })

        it('should return empty completion items when recommendation is empty', async function () {
            recommendations.response = []
            const mockPosition = new vscode.Position(14, 83)
            const mockDocument = createMockDocument()
            const actual = getCompletionItems(mockDocument, mockPosition)
            const expected: vscode.CompletionItem[] = []
            assert.deepStrictEqual(actual, expected)
        })
    })
})
