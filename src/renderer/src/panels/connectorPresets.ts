/**
 * Ready-made connector shapes for the Gateway panel's "add" form.
 *
 * A preset is only a form definition plus a function that turns the answers
 * into a manifest entry - the manifest stays the source of truth, and anything
 * a preset does not cover is still a hand edit of the YAML file.
 */

export interface PresetField {
  key: string
  label: string
  value?: string
  placeholder?: string
  /** Goes to the vault, never to the manifest. */
  secret?: boolean
  optional?: boolean
}

export interface ConnectorPreset {
  key: string
  label: string
  hint?: string
  fields: PresetField[]
  build(v: Record<string, string | undefined>): {
    entry: Record<string, unknown>
    /** Vault id for the secret field, when the preset has one. */
    credentialId?: string
  }
}

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    key: 'email-imap',
    label: '邮箱（IMAP）',
    hint: 'Gmail / Outlook 等需要「应用专用密码」，不是登录密码。',
    fields: [
      { key: 'id', label: 'Connector id', value: 'email' },
      { key: 'host', label: 'IMAP 服务器', value: 'imap.gmail.com' },
      { key: 'port', label: '端口', value: '993' },
      { key: 'user', label: '邮箱地址', placeholder: 'you@example.com' },
      { key: 'mailbox', label: '邮箱文件夹', value: 'INBOX', optional: true },
      { key: 'password', label: '应用专用密码', secret: true }
    ],
    build: (v) => ({
      credentialId: `${v.id}-imap`,
      entry: {
        id: v.id,
        transport: 'mcp-stdio',
        command: ['node', 'connectors/email-imap/server.js'],
        credential_ref: `vault://${v.id}-imap`,
        env: {
          IMAP_HOST: v.host,
          IMAP_PORT: v.port,
          IMAP_USER: v.user,
          ...(v.mailbox ? { IMAP_MAILBOX: v.mailbox } : {})
        },
        default_risk: 'read-only',
        overrides: { mark_read: 'write-reversible' }
      }
    })
  },
  {
    key: 'mcp-stdio',
    label: 'MCP 服务（stdio）',
    hint: '按空格拆分成 argv。未填风险等级时按最严档（每次调用都要人工批准）处理。',
    fields: [
      { key: 'id', label: 'Connector id', placeholder: 'gmail' },
      { key: 'command', label: '启动命令', placeholder: 'npx -y @modelcontextprotocol/server-xxx' },
      { key: 'default_risk', label: '默认风险等级', value: 'read-only' },
      { key: 'credential', label: '凭据（留空表示不需要）', secret: true, optional: true }
    ],
    build: (v) => ({
      ...(v.credential ? { credentialId: `${v.id}-secret` } : {}),
      entry: {
        id: v.id,
        transport: 'mcp-stdio',
        command: (v.command ?? '').split(/\s+/).filter(Boolean),
        ...(v.credential ? { credential_ref: `vault://${v.id}-secret` } : {}),
        default_risk: v.default_risk
      }
    })
  },
  {
    key: 'mcp-http',
    label: 'MCP 服务（HTTP）',
    fields: [
      { key: 'id', label: 'Connector id', placeholder: 'notion' },
      { key: 'url', label: 'Endpoint', placeholder: 'http://127.0.0.1:8000/mcp' },
      { key: 'default_risk', label: '默认风险等级', value: 'read-only' },
      { key: 'credential', label: '凭据（留空表示不需要）', secret: true, optional: true }
    ],
    build: (v) => ({
      ...(v.credential ? { credentialId: `${v.id}-secret` } : {}),
      entry: {
        id: v.id,
        transport: 'mcp-http',
        url: v.url,
        ...(v.credential ? { credential_ref: `vault://${v.id}-secret` } : {}),
        default_risk: v.default_risk
      }
    })
  }
]

export const RISK_OPTIONS = ['read-only', 'write-reversible', 'write-irreversible']
