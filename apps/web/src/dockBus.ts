/** bridge from dockview panel components (params-only props) to App's dock actions */
export const dockBus = {
  /** open a shell tab in a session's working directory (agent-shell view) */
  openShell: (_cwd: string, _title?: string) => {},
};
