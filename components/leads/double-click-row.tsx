"use client";

export type LeadEditPayload = {
  leadId: string;
  full_name: string | null;
  email: string | null;
  niche: string | null;
  bio: string | null;
  external_link: string | null;
  funnel_program_name: string | null;
};

export function DoubleClickRow({
  payload,
  children,
  className,
}: {
  payload: LeadEditPayload;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <tr
      className={className}
      onDoubleClick={(e) => {
        // Don't trigger when the user double-clicks an interactive element
        const target = e.target as HTMLElement;
        if (target.closest("a,button,input,textarea,select,[role=button]")) return;
        window.dispatchEvent(new CustomEvent("edit-lead", { detail: payload }));
      }}
    >
      {children}
    </tr>
  );
}
