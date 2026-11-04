import type { RoleChange } from "@/lib/chain/types";

function when(seconds: bigint): string {
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function Rotations({ keeperChange, guardianChange }: { keeperChange: RoleChange | null; guardianChange: RoleChange | null }) {
  const rows = [
    ["Keeper", keeperChange],
    ["Guardian", guardianChange],
  ].filter((r): r is [string, RoleChange] => r[1] !== null);
  if (rows.length === 0) return <p>No rotation is scheduled.</p>;
  return (
    <ul>
      {rows.map(([role, c]) => (
        <li key={role}>
          <span>Scheduled</span> · {role} → <span className="mono">{c.account}</span> · applies after {when(c.applyAfter)}
        </li>
      ))}
    </ul>
  );
}
