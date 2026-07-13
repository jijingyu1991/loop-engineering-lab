import { createInterface } from "node:readline/promises";

export type ApprovalDecision = "approved" | "rejected" | "unavailable";

export interface ApprovalRequest {
  executable: string;
  args: string[];
  cwd: string;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

function displayArgument(argument: string): string {
  return /^[a-zA-Z0-9_@%+=:,./-]+$/.test(argument)
    ? argument
    : JSON.stringify(argument);
}

/**
 * 当前项目没有 UI，审批必须在启动 loop 的同一个终端完成。展示字符串仅供人阅读；
 * 它不会被重新解析或交给 shell，真实执行仍使用原始 executable 与 args 数组。
 */
export function createTerminalApprovalHandler(options: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
}): ApprovalHandler {
  return async (request) => {
    // CI、重定向 stdin 等非交互环境不能等待一个永远不会到来的回答。
    if (!options.isTTY) return "unavailable";

    const command = [request.executable, ...request.args]
      .map(displayArgument)
      .join(" ");
    const readline = createInterface({
      input: options.input,
      output: options.output,
      terminal: true,
    });

    try {
      options.output.write([
        "Shell approval required\n",
        `cwd: ${request.cwd}\n`,
        `command: ${command}\n`,
      ].join(""));
      const answer = await readline.question("Allow this call? [y/N] ");
      return /^(y|yes)$/i.test(answer.trim()) ? "approved" : "rejected";
    } catch {
      // EOF 或输入流关闭与默认 N 等价；它表示没有得到明确批准。
      return "rejected";
    } finally {
      readline.close();
    }
  };
}
