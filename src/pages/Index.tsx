import { APP_NAME, WORKFLOW_STAGES } from '@/domain/workflow';

export default function Index() {
  return (
    <main className="min-h-screen bg-[#F4F5F7] text-[#1A1D23] p-6 md:p-10">
      <div className="mx-auto max-w-3xl rounded-lg border border-[#D9DCE1] bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#1D5FD1]">Stage 2 · Engineering skeleton</p>
        <h1 className="mt-1 text-2xl font-semibold">{APP_NAME}</h1>
        <p className="mt-2 text-sm text-[#4B5260]">Tests define what done means. The core workflow is not implemented yet.</p>
        <ol className="mt-6 grid gap-2 sm:grid-cols-2">
          {WORKFLOW_STAGES.map((s, i) => (
            <li key={s} className="rounded-md border border-[#D9DCE1] px-3 py-2 text-sm">
              <span className="mr-2 font-mono text-[#6B7280]">{i + 1}.</span>
              {s}
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
