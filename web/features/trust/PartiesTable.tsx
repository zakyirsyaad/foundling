import { PARTY_GROUPS } from "@/content/trust";

export function PartiesTable() {
  return (
    <div className="fm-table-wrap">
      <table aria-label="Who you trust" className="fm-table text-sm">
        <thead>
          <tr>
            <th scope="col">Party</th>
            <th scope="col">What it could do</th>
            <th scope="col">What limits it</th>
          </tr>
        </thead>
        {PARTY_GROUPS.map((g) => (
          <tbody key={g.group}>
            <tr className="group">
              <th scope="rowgroup" colSpan={3} className="text-left">{g.group}</th>
            </tr>
            {g.rows.map((r) => (
              <tr key={r.party}>
                <th scope="row" className="font-semibold">{r.party}</th>
                <td data-label="What it could do">{r.could}</td>
                <td data-label="What limits it">{r.bounded}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
