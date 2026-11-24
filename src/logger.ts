import * as vscode from 'vscode';

/** Minimal wrapper around an output channel so every module can log consistently. */
export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(name = 'Diff Compare') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.channel.appendLine(`[info] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[warn] ${message}`);
  }

  error(message: string, error?: unknown): void {
    this.channel.appendLine(`[error] ${message}`);
    if (error !== undefined) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.channel.appendLine(text);
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
