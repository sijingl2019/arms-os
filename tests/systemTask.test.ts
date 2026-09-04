import { describe, expect, it } from 'vitest'
import { planSystemTask } from '@main/routines/systemTask'
import type { RoutineDef } from '@shared/types'

function routine(overrides: Partial<RoutineDef> = {}): RoutineDef {
  return {
    id: 'abc123',
    name: 'morning digest',
    skillId: 'news-digest',
    cron: '0 9 * * *',
    timezone: null,
    args: null,
    agent: null,
    model: null,
    effort: null,
    enabled: true,
    missedRunPolicy: 'skip',
    maxRetries: 0,
    retryDelayMs: 60_000,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastRunId: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides
  }
}

const WS = 'E:\Workspace\arms-os'

describe('planSystemTask on Windows', () => {
  it('emits a daily schtasks command that re-enters the ARMS CLI', () => {
    const plan = planSystemTask({ routine: routine(), workspaceRoot: WS, platform: 'win32' })

    expect(plan.command).toContain('schtasks /Create')
    expect(plan.command).toContain('/SC DAILY /ST 09:00')
    expect(plan.command).toContain('arms.ts run news-digest')
    // Re-entering our own CLI is what keeps the run in the runs table.
    expect(plan.command).not.toContain('claude -p')
  })

  it('translates a weekday list to /SC WEEKLY', () => {
    const plan = planSystemTask({
      routine: routine({ cron: '30 7 * * 1,3,5' }),
      workspaceRoot: WS,
      platform: 'win32'
    })
    expect(plan.command).toContain('/SC WEEKLY /D MON,WED,FRI /ST 07:30')
  })

  it('passes routine args and model through', () => {
    const plan = planSystemTask({
      routine: routine({ args: 'only-cn', model: 'claude-sonnet-5' }),
      workspaceRoot: WS,
      platform: 'win32'
    })
    expect(plan.command).toContain('--args only-cn')
    expect(plan.command).toContain('--model claude-sonnet-5')
  })

  it('refuses to mistranslate a cron schtasks cannot express', () => {
    const plan = planSystemTask({
      routine: routine({ cron: '*/15 * * * *' }),
      workspaceRoot: WS,
      platform: 'win32'
    })
    expect(plan.command).toBe('')
    expect(plan.notes.join(' ')).toMatch(/cannot express/)
  })

  it('warns that an OS task ignores the routine timezone', () => {
    const plan = planSystemTask({
      routine: routine({ timezone: 'Asia/Shanghai' }),
      workspaceRoot: WS,
      platform: 'win32'
    })
    expect(plan.notes.join(' ')).toMatch(/Asia\/Shanghai/)
  })

  it('always warns about double firing', () => {
    const plan = planSystemTask({ routine: routine(), workspaceRoot: WS, platform: 'win32' })
    expect(plan.notes.join(' ')).toMatch(/double runs/)
  })
})

describe('planSystemTask on linux', () => {
  it('appends a crontab line carrying the raw cron expression', () => {
    const plan = planSystemTask({
      routine: routine({ cron: '*/15 * * * *' }),
      workspaceRoot: '/home/me/ws',
      platform: 'linux'
    })
    expect(plan.command).toContain('crontab -')
    expect(plan.command).toContain('*/15 * * * *')
    expect(plan.command).toContain('# ARMS abc123')
  })
})

describe('planSystemTask on darwin', () => {
  it('emits a launchd plist with a calendar interval', () => {
    const plan = planSystemTask({
      routine: routine(),
      workspaceRoot: '/Users/me/ws',
      platform: 'darwin'
    })
    expect(plan.command).toContain('com.arms-os.abc123')
    expect(plan.command).toContain('<key>Hour</key><integer>9</integer>')
    expect(plan.command).toContain('<key>Minute</key><integer>0</integer>')
    expect(plan.command).toContain('launchctl load')
  })
})
