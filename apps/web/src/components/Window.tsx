import type { ReactNode } from "react";

// Retro desktop window: cream panel, black hairline, title bar with a (decorative) close box.

export function Window({
  title,
  className = "",
  bodyClassName = "",
  headingLevel = 2,
  children,
}: {
  title: ReactNode;
  className?: string;
  bodyClassName?: string;
  headingLevel?: 1 | 2 | 3;
  children: ReactNode;
}) {
  const H = `h${headingLevel}` as "h1" | "h2" | "h3";
  return (
    <section className={`window ${className}`}>
      <div className="window-bar">
        <span className="window-close" aria-hidden />
        <span className="window-grip" aria-hidden />
        <H className="window-title">{title}</H>
      </div>
      <div className={`window-body ${bodyClassName}`}>{children}</div>
    </section>
  );
}
