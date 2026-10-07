import { messages } from "@/lib/messages";

function Bone({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={`sk block ${className}`} style={style} />;
}

function Status({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{messages.common.loading}</span>
      {children}
    </div>
  );
}

function Top() {
  return (
    <div className="top">
      <div className="flex flex-col gap-2.5 min-w-0 w-full max-w-[520px]">
        <Bone className="h-[26px] w-[220px] rounded-[8px]" />
        <Bone className="h-[13px] w-full max-w-[420px] rounded-[6px]" />
      </div>
      <Bone className="h-[38px] w-[150px] rounded-full flex-none max-[900px]:hidden" />
    </div>
  );
}

export function CardsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <Status>
      <div className="page wide">
      <Top />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 py-6">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="card p-3 flex flex-col gap-3">
            <div className="figure-stage h-[150px]" style={{ "--tint": "#8b8c8d" } as React.CSSProperties}>
              <Bone className="h-[96px] w-[96px] rounded-full" />
            </div>
            <div className="px-2 flex flex-col gap-2">
              <Bone className="h-[16px] w-[60%] rounded-[6px]" />
              <Bone className="h-[12px] w-[80%] rounded-[6px]" />
            </div>
            <div className="mx-2 flex flex-col gap-1.5 min-h-[38px]">
              <Bone className="h-[12px] w-full rounded-[6px]" />
              <Bone className="h-[12px] w-[70%] rounded-[6px]" />
            </div>
            <div className="mx-2 mb-1 pt-2.5 border-t border-line">
              <Bone className="h-[11px] w-[40%] rounded-[6px]" />
            </div>
          </div>
        ))}
      </div>
      </div>
    </Status>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Status>
      <div className="page narrow">
      <Top />
      <div className="flex flex-col gap-4 py-5">
        <div className="flex gap-2">
          {[64, 84, 72].map((width) => (
            <Bone key={width} className="h-[24px] rounded-full" style={{ width }} />
          ))}
        </div>
        <div className="card overflow-hidden">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-[18px] py-3.5 border-t border-graphite first:border-0">
              <Bone className="h-[30px] w-[30px] rounded-full flex-none" />
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <Bone className="h-[13px] rounded-[6px]" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
                <Bone className="h-[11px] w-[30%] rounded-[6px]" />
              </div>
              <Bone className="h-[22px] w-[70px] rounded-full flex-none" />
            </div>
          ))}
        </div>
      </div>
      </div>
    </Status>
  );
}

export function AgentSkeleton() {
  return (
    <Status>
      <div className="grid grid-cols-[400px_1fr] h-screen max-[1000px]:grid-cols-1 max-[1000px]:h-auto">
        <section className="bg-void border-r border-graphite flex flex-col min-h-0 max-[1000px]:h-[70vh] max-[1000px]:border-r-0 max-[1000px]:border-b">
          <div className="flex gap-3 items-center p-[18px] border-b border-graphite">
            <Bone className="h-[44px] w-[44px] rounded-full flex-none" />
            <div className="flex-1 flex flex-col gap-2">
              <Bone className="h-[15px] w-[55%] rounded-[6px]" />
              <Bone className="h-[11px] w-[40%] rounded-[6px]" />
            </div>
          </div>
          <div className="flex gap-4 px-[18px] py-3 border-b border-graphite">
            {[52, 44, 36, 58, 34, 52].map((width, i) => (
              <Bone key={i} className="h-[12px] rounded-[6px]" style={{ width }} />
            ))}
          </div>
          <div className="flex-1 flex flex-col gap-4 p-[18px] overflow-hidden">
            <div className="flex flex-col gap-2 max-w-[85%]">
              <Bone className="h-[11px] w-[120px] rounded-[6px]" />
              <Bone className="h-[13px] w-full rounded-[6px]" />
              <Bone className="h-[13px] w-[80%] rounded-[6px]" />
            </div>
            <Bone className="h-[34px] w-[55%] rounded-xl self-end" />
            <div className="flex flex-col gap-2 max-w-[85%]">
              <Bone className="h-[11px] w-[110px] rounded-[6px]" />
              <Bone className="h-[13px] w-full rounded-[6px]" />
              <Bone className="h-[13px] w-[65%] rounded-[6px]" />
            </div>
          </div>
          <div className="p-[18px]">
            <Bone className="h-[72px] w-full rounded-[12px]" />
          </div>
        </section>
        <section className="flex flex-col gap-3 p-[18px] min-h-0 max-[1000px]:min-h-[60vh]">
          <div className="flex justify-between items-center gap-3">
            <Bone className="h-[24px] w-[260px] rounded-full" />
            <div className="flex gap-2">
              <Bone className="h-[38px] w-[120px] rounded-full" />
              <Bone className="h-[38px] w-[120px] rounded-full" />
            </div>
          </div>
          <Bone className="flex-1 min-h-[300px] w-full rounded-[14px]" />
          <Bone className="h-[28px] w-[220px] rounded-full" />
        </section>
      </div>
    </Status>
  );
}
