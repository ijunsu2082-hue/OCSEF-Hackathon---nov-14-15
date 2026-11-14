"use client";

import { useId, useState } from "react";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]";

/** One or two plain sentences per panel section. */
const ITEMS: { title: string; text: string }[] = [
  {
    title: "Map dots and colors",
    text: "Each dot is a power plant, and a bigger dot makes more power. Sky blue is clean power like solar or wind, light blue is batteries, gray is fuel like gas, and thin lines are power lines.",
  },
  {
    title: "Line capacity right now",
    text: "Power lines heat up as they carry electricity, so each one has a fixed safety limit set for a very hot 40 C (104 F) day with little wind. This number compares that worst-case limit with what today's cooler weather would safely allow.",
  },
  {
    title: "Why this matters",
    text: "Extra room on the lines means more clean power can reach homes instead of being wasted. This section shows how much that could add up to.",
  },
  {
    title: "At a glance",
    text: "Small charts that show what kinds of power plants are here, how old they are, how many miles of power line there are, and what is shutting down or being built.",
  },
  {
    title: "What's here",
    text: "The main numbers for this circle, like how many plants, power lines and substations it has.",
  },
  {
    title: "Risk factors",
    text: "Our own score from 0 to 100 that adds up things like old plants, heat and past problems. It is a rough guide, not an official rating.",
  },
  {
    title: "Top plants",
    text: "The biggest power plants in the circle. Click one to see it on the map.",
  },
  {
    title: "Retired and proposed generators",
    text: "Power plants here that have shut down, and new ones that companies plan to build.",
  },
  {
    title: "Local news",
    text: "Real news stories and public records about the power grid near this spot.",
  },
  {
    title: "Report a problem",
    text: "Helps you send a complaint about the power grid to the right office. If something is on fire or a wire is down, call 911 first.",
  },
];

/** Small "What am I looking at?" link that opens a plain-language guide to the panel. */
export function Explainer() {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div className="px-6 pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={`rounded-[6px] text-[13px] font-medium text-[#0369a1] hover:underline ${FOCUS}`}
      >
        {open ? "Hide the guide" : "What am I looking at?"}
      </button>
      <div id={id} hidden={!open} className="mt-3 border-b border-[#e6e9ee] pb-4">
        <dl className="space-y-2">
          {ITEMS.map((it) => (
            <div key={it.title}>
              <dt className="text-[13px] font-semibold text-[#1d2733]">{it.title}</dt>
              <dd className="text-[14px] leading-snug text-[#556070]">{it.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
