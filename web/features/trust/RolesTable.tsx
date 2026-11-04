import type { Roles } from "@/lib/chain/types";

const ROWS = [
  { role: "Governor", key: "governor" as const, can: "Unfreeze, clear a halt, tighten the policy, add depositors, schedule keeper and guardian changes after the timelock.", cannot: "Loosen a cap, add an asset or route, change the strategy, upgrade the contract, move funds, or open the secret." },
  { role: "Keeper", key: "keeper" as const, can: "Start a cycle and run its steps: trigger_cycle, execute_decision, advance, abort_stale_cycle, expire_decision.", cannot: "Make the decision or move funds." },
  { role: "Guardian", key: "guardian" as const, can: "freeze and cancel_keeper_change.", cannot: "Unfreeze, change the policy, or move funds." },
];

export function RolesTable({ roles }: { roles: Roles }) {
  return (
    <table aria-label="Roles" className="fm-table text-sm">
      <thead>
        <tr>
          <th scope="col">Role</th>
          <th scope="col">Account</th>
          <th scope="col">Can</th>
          <th scope="col">Cannot</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map((r) => (
          <tr key={r.role}>
            <th scope="row">{r.role}</th>
            <td data-label="Account" className="mono">{roles[r.key]}</td>
            <td data-label="Can">{r.can}</td>
            <td data-label="Cannot">{r.cannot}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
