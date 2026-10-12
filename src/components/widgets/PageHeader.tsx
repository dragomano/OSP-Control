import type { ReactNode } from 'react';

export function PageHeader({
  eyebrow,
  heading,
  description,
  action,
}: {
  eyebrow: string;
  heading: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{heading}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
