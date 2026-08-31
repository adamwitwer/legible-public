export type Device = {
  id: string;
  label: string | null;
  /** The domain this passkey was registered under. */
  rp_id: string;
  /** False for a passkey from another domain: it exists, but can never sign in. */
  usable: boolean;
  created_at: string;
  last_used_at: string | null;
};

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'never';

export function Devices({ devices, onClose }: { devices: Device[]; onClose: () => void }) {
  return (
    <div className="devices">
      <div className="devices-head">
        <span>passkeys</span>
        <span className="devices-hint">:forget &lt;id&gt; to remove · esc to close</span>
      </div>

      {devices.length === 0 ? (
        <p className="devices-empty">none enrolled — the enroll code will work again</p>
      ) : (
        <div className="devices-scroll">
        <table className="devices-table">
          <thead>
            <tr>
              <th>id</th>
              <th>label</th>
              <th>added</th>
              <th>last used</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className={d.usable ? '' : 'devices-stale'}>
                {/* data-label carries the column name for the stacked
                    phone layout, where the header row is hidden */}
                {/* selectable: this is the id :forget takes */}
                <td data-label="id" className="devices-id">{d.id}</td>
                <td data-label="label" className="devices-label">
                  {d.label ?? '—'}
                  {/* A passkey from an old domain is not stale in the usual sense:
                      the authenticator will not offer it at all. Say so, because
                      nothing else about the row hints at it. */}
                  {!d.usable && (
                    <span className="devices-otherdomain" title={`registered under ${d.rp_id} — cannot sign in here`}>
                      {' '}other domain
                    </span>
                  )}
                </td>
                <td data-label="added">{when(d.created_at)}</td>
                <td data-label="last used" className={d.last_used_at ? '' : 'devices-never'}>
                  {when(d.last_used_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <button className="btn devices-close" onClick={onClose}>close</button>
    </div>
  );
}
