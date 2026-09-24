import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'

/** Use the same outbound proxy policy as DSH, including its public-URL checks. */
export function configureNetwork(
  env: NodeJS.ProcessEnv = process.env,
  report: (message: string) => void = console.warn,
) {
  return installProxyFromEnvironment(
    { get: (name) => (env[name] === undefined ? undefined : { value: env[name] }) },
    report,
  )
}
