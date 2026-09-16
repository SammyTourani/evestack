import { QueueDiagnosisPanel } from "@/components/queue-diagnosis";
export default function DoctorPage() {
  return (
    <>
      <h1>Queue diagnosis</h1>
      <p className="page-sub">
        Read-only findings for durable work that may need attention.
      </p>
      <QueueDiagnosisPanel />
    </>
  );
}
