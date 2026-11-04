export type DesktopInstallation = {installed: boolean; version: string | null; directory: string; executable: string; running: boolean};
export function inspectInstallation(): DesktopInstallation;
export function waitForDesktopClosed(inspect?: () => {running: boolean}, delay?: (ms: number) => Promise<unknown>): Promise<void>;
export function updateDesktop(options?: {checkOnly?: boolean; buildOnly?: boolean; prepared?: {version: string; sha256: string} | null}): Promise<Record<string, unknown>>;
