/**
 * The card's styles, injected once per page.
 *
 * The harness's own client bundles inject a `<style data-plugin-css>` tag at
 * materialization rather than shipping a stylesheet, because a plugin bundle is
 * a single script with no CSS pipeline behind it; this follows that convention
 * exactly, including the idempotence guard, so a reload cannot stack duplicate
 * tags.
 *
 * Every colour is one of the harness's own theme aliases, so the card follows
 * light and dark without knowing which is active. The single exception is the
 * per-peer accent, which is a hue this plugin derives — supplied by the
 * component as a custom property rather than hardcoded here.
 */

/** Identifies this plugin's style tag, and makes injection idempotent. */
const TAG_ID = 'dsh-agent-messaging/AgentMessageCard.css'

/** Class names the card renders with. */
export const css = {
  root: 'dsh-am-root',
  head: 'dsh-am-head',
  avatar: 'dsh-am-avatar',
  who: 'dsh-am-who',
  name: 'dsh-am-name',
  direction: 'dsh-am-direction',
  pills: 'dsh-am-pills',
  pill: 'dsh-am-pill',
  pillWarn: 'dsh-am-pill-warn',
  time: 'dsh-am-time',
  body: 'dsh-am-body',
  meta: 'dsh-am-meta',
} as const

const STYLES = `
.${css.root} {
  --dsh-am-accent: hsl(var(--dsh-am-hue, 210) 62% 52%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  margin: 4px 0;
  padding: 10px 12px 10px 13px;
  border: 1px solid var(--dsw-alias-line-secondary);
  border-left: 3px solid var(--dsh-am-accent);
  border-radius: 8px;
  background: var(--dsw-alias-bg-module-platform);
}
.${css.head} {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.${css.avatar} {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--dsh-am-accent);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.${css.who} {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.${css.name} {
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${css.direction} {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 20px;
}
.${css.pills} {
  display: flex;
  flex: auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
}
.${css.pill} {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-line-secondary);
  border-radius: 999px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.${css.pillWarn} {
  border-color: var(--dsw-alias-state-warn-tertiary);
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}
.${css.time} {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}
.${css.body} {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.${css.meta} {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 0;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
`

/**
 * Put the card's styles on the page, once.
 *
 * Safe to call on every materialization: a second call with the tag already
 * present does nothing.
 */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return

  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-agent-messaging'
  tag.dataset['pluginCss'] = TAG_ID
  tag.textContent = STYLES
  document.head.appendChild(tag)
}
