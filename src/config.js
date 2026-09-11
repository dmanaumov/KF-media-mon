require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  mattermostUrl: (process.env.MATTERMOST_URL || '').replace(/#+\/?$/, '').replace(/\/+$/, ''),
  mattermostLoginId: process.env.MATTERMOST_LOGIN_ID || '',
  mattermostPassword: process.env.MATTERMOST_PASSWORD || '',
  mattermostToken: process.env.MATTERMOST_TOKEN || '',
  boardsApiPrefix: process.env.MATTERMOST_BOARDS_API_PREFIX || '/plugins/focalboard/api/v2',
  teamId: process.env.MATTERMOST_TEAM_ID || '4wd5nx3wffbmjg3a9cjjcgi8tw',
  mattermostBoardId: process.env.MATTERMOST_BOARD_ID || 'b4h1ef6wwnfnjze9m6jghwfugzr',
  mattermostWebUrl: process.env.MATTERMOST_WEB_URL || '',

  projectPropertyName: process.env.MM_PROJECT_PROPERTY_NAME || 'Проект',
  statusPropertyName: process.env.MM_STATUS_PROPERTY_NAME || 'Статус',
  datePropertyName: process.env.MM_DATE_PROPERTY_NAME || 'Дедлайн // Релиз',
  timeDeadlinePropertyName: process.env.MM_TIME_DEADLINE_PROPERTY_NAME || 'Время дедлайна (если применимо)',
  smiPropertyName: process.env.MM_SMI_PROPERTY_NAME || 'СМИ/ресурс',
  urlPropertyName: process.env.MM_URL_PROPERTY_NAME || 'Ссылка на публикацию',
  uvmPropertyName: process.env.MM_UVM_PROPERTY_NAME || 'UVM',
  typePropertyName: process.env.MM_TYPE_PROPERTY_NAME || 'Тип текста',
  priorityPropertyName: process.env.MM_PRIORITY_PROPERTY_NAME || 'Приоритет',
  assigneePropertyName: process.env.MM_ASSIGNEE_PROPERTY_NAME || 'Ответственный',

  // Client cabinet (anonymous /l/:token link) only ever shows cards in these
  // statuses — the client should see "approving with speaker / sent to
  // editorial / published", not the internal pipeline (idea, draft, etc).
  clientVisibleStatuses: (process.env.CLIENT_VISIBLE_STATUSES || 'Согласовываем со спикером,Отдали в редакцию,Опубликован')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '10000', 10),
  requestTimeoutMs: parseInt(process.env.MM_REQUEST_TIMEOUT_MS || '15000', 10),
  debug: (process.env.DEBUG_MATTERMOST || 'false').toLowerCase() === 'true',
  automationApiKey: process.env.AUTOMATION_API_KEY || '',

  databaseUrl: process.env.DATABASE_URL || '',

  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  adminLogins: (process.env.ADMIN_LOGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  teamCabinetPath: process.env.TEAM_CABINET_PATH || '/team',
  adminPath: process.env.ADMIN_PATH || '/admin',
};