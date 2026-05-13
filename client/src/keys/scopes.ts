/**
 * Scope tokens for the keyboard shortcut registry.
 *
 * Every screen registers its bindings under one of these scopes. The
 * dispatcher matches against the active scope plus the always-on
 * `'global'` scope.
 */
export type ShortcutScope =
  | 'global'
  | 'projects'
  | 'inbox'
  | 'grid'
  | 'kanban'
  | 'activity'
  | 'task_detail'
  | 'project_detail'
  | 'screen_host'
  | 'login'
  | 'admin_users'
  | 'admin_attributes'
  | 'admin_screens'
  | 'admin_agents'
  | 'admin_projects'
  | 'admin_flows'
  | 'admin_comm_log'
  | 'admin_comm_channels';
