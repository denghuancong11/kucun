const paths: Record<string, string[]> = {
  box: [
    "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
    "m3.3 7 8.7 5 8.7-5",
    "M12 22V12",
  ],
  refresh: [
    "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
    "M3 3v5h5",
    "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16",
    "M16 16h5v5",
  ],
  check: [
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
    "M9 2h6v4H9z",
    "m9 14 2 2 4-4",
  ],
  search: ["m21 21-4.34-4.34", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16"],
  plus: ["M12 5v14", "M5 12h14"],
  chevron: ["m6 9 6 6 6-6"],
  alert: [
    "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z",
    "M12 9v4",
    "M12 17h.01",
  ],
  shield: [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z",
  ],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"],
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20", "M12 16v-4", "M12 8h.01"],
  circleCheck: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20", "m9 12 2 2 4-4"],
  lock: [
    "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2Z",
    "M7 11V7a5 5 0 0 1 10 0v4",
  ],
  x: ["M18 6 6 18", "m6 6 12 12"],
  package: [
    "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73Z",
    "M12 22V12",
    "m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7",
    "m7.5 4.27 9 5.15",
  ],
  clock: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
    "M12 6v6l4 2",
  ],
  sliders: [
    "M4 21v-7",
    "M4 10V3",
    "M12 21v-9",
    "M12 8V3",
    "M20 21v-5",
    "M20 12V3",
    "M1 14h6",
    "M9 8h6",
    "M17 16h6",
  ],
  compress: [
    "M4 14h6v6",
    "M20 10h-6V4",
    "M14 10l7-7",
    "M3 21l7-7",
  ],
  expand: [
    "M15 3h6v6",
    "M9 21H3v-6",
    "M21 3l-7 7",
    "M3 21l7-7",
  ],
  command: [
    "M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z",
  ],
  filter: [
    "M22 3H2l8 9.46V19l4 2v-8.54L22 3z",
  ],
  columns: [
    "M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18",
  ],
  sparkles: [
    "m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z",
  ],
  layers: [
    "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
    "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
    "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
  ],
  arrowUp: [
    "m5 12 7-7 7 7",
    "M12 19V5",
  ],
  arrowDown: [
    "m19 12-7 7-7-7",
    "M12 5v14",
  ],
  /* 调出：箭头离开容器，避免与“功能已暂停”的锁图标撞语义 */
  dispatch: [
    "M3 7v10a2 2 0 0 0 2 2h6",
    "M3 7a2 2 0 0 1 2-2h6",
    "m14 12 7 0",
    "m18 8 4 4-4 4",
  ],
  undo: [
    "M3 7v6h6",
    "M3.51 13a9 9 0 1 0 2.13-5.36L3 13",
  ],
};

interface IconProps {
  name: keyof typeof paths | string;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 16, strokeWidth = 2, className, style }: IconProps) {
  const d = paths[name] ?? paths.info;
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}
