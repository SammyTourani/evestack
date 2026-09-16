import { getRegressionCase, validCaseId } from "@/lib/regressions";
import { DatabaseError } from "@/app/db-error";
import { CaseWorkspace } from "../workspace";
export const dynamic = "force-dynamic";
export default async function CasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!validCaseId(id))
    return (
      <p>
        Invalid case id. <a href="/regressions">Open saved cases</a>
      </p>
    );
  let regression;
  try {
    regression = await getRegressionCase(id);
  } catch (error) {
    return <DatabaseError error={error} />;
  }
  if (!regression)
    return (
      <p>
        Case not found. <a href="/regressions">Open saved cases</a>
      </p>
    );
  return (
    <CaseWorkspace
      key={regression.current.revision}
      regression={JSON.parse(JSON.stringify(regression))}
    />
  );
}
