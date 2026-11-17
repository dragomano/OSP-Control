import type { ReactNode } from 'react';
import { SectionHeader } from '../ui';

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
    <SectionHeader className="page-header">
      <div className="page-header-copy">
        <div className="eyebrow">{eyebrow}</div>
        <h1>{heading}</h1>
        <p>{description}</p>
      </div>
      {action}
    </SectionHeader>
  );
}
