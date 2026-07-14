const CREDENTIAL_KEY = /(key|token|secret|password|credential)/i;

/**
 * 工具失败证据会进入 trace，也会返回给 Agent，因此不能原样保存进程输出中的凭据。
 * 这里先按环境变量名识别已配置的敏感值，再覆盖常见 Bearer token 与 OpenAI 风格 key；
 * 长值优先替换，避免一个短 secret 是另一个长 secret 的子串时留下残片。
 */
export function sanitizeToolText(
  value: string,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  let sanitized = value;
  const configuredSecrets = Object.entries(environment)
    .filter(
      ([key, configuredValue]) =>
        CREDENTIAL_KEY.test(key) &&
        configuredValue !== undefined &&
        configuredValue.length >= 4,
    )
    .map(([, configuredValue]) => configuredValue as string)
    .sort((left, right) => right.length - left.length);

  for (const secret of configuredSecrets) {
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }

  return sanitized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}
