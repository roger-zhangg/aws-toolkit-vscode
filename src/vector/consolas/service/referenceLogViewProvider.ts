/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { References } from '../client/consolas'
import { LicenseUtil } from '../util/licenseUtil'
import { ConsolasConstants } from '../models/constants'
import { telemetryContext } from '../models/model'
import { ConsolasSettings } from '../util/consolasSettings'
import { isCloud9 } from '../../../shared/extensionUtilities'

export class ReferenceLogViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aws.consolas.referenceLog'
    private _view?: vscode.WebviewView
    private _referenceLogs: string[] = []
    private _settings: ConsolasSettings
    constructor(private readonly _extensionUri: vscode.Uri, settings: ConsolasSettings) {
        this._settings = settings
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext<unknown>,
        token: vscode.CancellationToken
    ): void | Thenable<void> {
        this._view = webviewView

        this._view.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        }
        this._view.webview.html = this.getHtml(
            webviewView.webview,
            this._settings.isIncludeSuggestionsWithCodeReferencesEnabled()
        )
        this._view.webview.onDidReceiveMessage(data => {
            vscode.commands.executeCommand('aws.consolas.configure', 'consolas')
        })
    }

    public async update() {
        if (this._view) {
            const showPrompt = this._settings.isIncludeSuggestionsWithCodeReferencesEnabled()
            this._view.webview.html = this.getHtml(this._view.webview, showPrompt)
        }
    }

    public static getReferenceLog(recommendation: string, references: References, editor: vscode.TextEditor): string {
        const filePath = editor.document.uri.path
        const time = new Date().toLocaleString()
        let text = ``
        for (const reference of references) {
            if (
                reference.contentSpan == undefined ||
                reference.contentSpan.start == undefined ||
                reference.contentSpan.end == undefined
            ) {
                continue
            }
            const code = recommendation.substring(reference.contentSpan.start, reference.contentSpan.end)
            const firstCharLineNumber =
                editor.document.positionAt(telemetryContext.cursorOffset + reference.contentSpan.start).line + 1
            const lastCharLineNumber =
                editor.document.positionAt(telemetryContext.cursorOffset + reference.contentSpan.end - 1).line + 1
            const license = `<a href=${LicenseUtil.getLicenseHtml(reference.licenseName)}>${reference.licenseName}</a>`
            let lineInfo = ``
            if (firstCharLineNumber === lastCharLineNumber) {
                lineInfo = `(line at ${firstCharLineNumber})`
            } else {
                lineInfo = `(lines from ${firstCharLineNumber} to ${lastCharLineNumber})`
            }
            if (text != ``) {
                text += `And `
            }
            const repository = reference.repository != undefined ? reference.repository : 'unknown'
            text +=
                ConsolasConstants.referenceLogText(
                    `<br><code>${code}</code><br>`,
                    license,
                    repository,
                    filePath,
                    lineInfo
                ) + ' <br>'
        }
        return `[${time}] Accepted recommendation ${text}<br>`
    }

    public addReferenceLog(referenceLog: string) {
        this._referenceLogs.push(referenceLog)
        this.update()
    }
    // TODO: migrate to vue based webview
    private getHtml(webview: vscode.Webview, showPrompt: boolean): string {
        const styleVSCodeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'css/consolasReferenceLog.css')
        )
        const prompt = showPrompt ? ConsolasConstants.referenceLogPromptText : ''
        let csp = ''
        if (isCloud9()) {
            csp = `<meta
            http-equiv="Content-Security-Policy"
            content=
                "default-src 'none';
                img-src https: data:;
                script-src 'self' 'unsafe-inline';
                style-src 'self' 'unsafe-inline' ${webview.cspSource};
                font-src 'self' data:;"
            >`
        }
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
				${csp}
                <link rel="stylesheet" href="${styleVSCodeUri}">
            </head>
            <body>
                <p>${prompt} </p>
                <p> ${this._referenceLogs.join('')} </p>
                <script>
                const vscode = acquireVsCodeApi();
                function openSettings() {
                    vscode.postMessage('aws.explorer.focus')
                }
                </script>
            </body>
            </html>`
    }
}
