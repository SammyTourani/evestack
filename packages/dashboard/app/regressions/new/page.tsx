import { NewRegressionCase } from "../workspace";
export const dynamic = "force-dynamic";
export default async function NewCasePage({
  searchParams,
}: {
  searchParams: Promise<{ task?: string }>;
}) {
  const task = (await searchParams).task;
  return (
    <>
      <h1>Save a correction</h1>
      <p className="page-sub">
        Record the original evidence and the behavior you want to check next
        time.
      </p>
      <NewRegressionCase
        initialTask={task && task.length <= 300 ? task : undefined}
      />
    </>
  );
}
