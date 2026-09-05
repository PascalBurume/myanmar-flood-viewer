/**
 * Times are shown in Myanmar time: the data is about Myanmar, so that is what its readers use.
 * One formatter, shared by the panel, the timeline and the popups, so "MMT" is spelled one way.
 */
export function formatMMT(iso: string, opts: { seconds?: boolean; short?: boolean } = {}): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yangon',
    ...(opts.short ? {} : { year: 'numeric' }),
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  }).format(d)
  return `${s} MMT`
}
