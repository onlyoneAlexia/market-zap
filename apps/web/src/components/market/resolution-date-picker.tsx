"use client";

import { useState, useMemo, useCallback, useId } from "react";
import { CalendarBlank, Clock, CaretLeft, CaretRight } from "@phosphor-icons/react";

const PRESETS = [
  { label: "1 hour", hours: 1 },
  { label: "6 hours", hours: 6 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
  { label: "1 month", hours: 720 },
  { label: "3 months", hours: 2160 },
] as const;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function toLocalDateString(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalTimeString(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRelative(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "in the past";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `in ${days}d ${hours % 24}h`;
  const months = Math.floor(days / 30);
  return `in ~${months}mo`;
}

function formatDisplay(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface ResolutionDatePickerProps {
  value: string; // datetime-local string
  onChange: (value: string) => void;
  hasError?: boolean;
  dateButtonId?: string;
  timeInputId?: string;
  /** When true, uses brighter text for dark-overlay visibility */
  privacyMode?: boolean;
}

export function ResolutionDatePicker({
  value,
  onChange,
  hasError,
  dateButtonId,
  timeInputId,
  privacyMode,
}: ResolutionDatePickerProps) {
  // Color overrides for privacy/dark-overlay mode
  const pm = privacyMode
    ? {
        presetActive: "border-slate-400/30 bg-slate-400/10 text-slate-300 font-bold",
        presetInactive: "border-[rgba(70,90,115,0.2)] bg-[rgba(5,10,18,0.4)] text-slate-400 hover:text-slate-300 hover:border-slate-400/30",
        fieldBorder: "border-[rgba(70,90,115,0.2)]",
        fieldHover: "hover:border-slate-400/30",
        icon: "text-slate-500",
        text: "text-slate-300",
        placeholder: "text-slate-500",
        calBg: "bg-[rgba(8,12,20,0.95)] border-[rgba(70,90,115,0.2)]",
        calDay: "text-slate-300 hover:bg-slate-400/10",
        calDaySelected: "bg-slate-400/20 text-slate-200 font-medium",
        calDayToday: "bg-slate-400/10 text-slate-300 font-medium hover:bg-slate-400/15",
        calDayPast: "text-slate-600 cursor-not-allowed",
        calHeader: "text-slate-500",
        calNav: "text-slate-500 hover:bg-slate-400/10 hover:text-slate-300",
        previewBg: "bg-[rgba(5,10,18,0.5)] border-[rgba(70,90,115,0.15)]",
        previewText: "text-slate-400",
        previewAccent: "text-slate-300",
      }
    : null;
  const [showCalendar, setShowCalendar] = useState(false);
  const calendarId = useId();
  const [viewMonth, setViewMonth] = useState(() => {
    if (value) return new Date(value);
    return new Date();
  });

  const parsed = useMemo(() => (value ? new Date(value) : null), [value]);
  const selectedDateStr = parsed ? toLocalDateString(parsed) : "";
  const selectedTime = parsed ? toLocalTimeString(parsed) : "12:00";

  const applyPreset = useCallback((hours: number) => {
    const d = new Date(Date.now() + hours * 3600_000);
    // Round to nearest 5 min
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    onChange(`${toLocalDateString(d)}T${toLocalTimeString(d)}`);
    setShowCalendar(false);
  }, [onChange]);

  const handleDateSelect = useCallback((dateStr: string) => {
    onChange(`${dateStr}T${selectedTime}`);
  }, [onChange, selectedTime]);

  const handleTimeChange = useCallback((time: string) => {
    if (!selectedDateStr) {
      // No date selected yet — use today
      const today = toLocalDateString(new Date());
      onChange(`${today}T${time}`);
    } else {
      onChange(`${selectedDateStr}T${time}`);
    }
  }, [onChange, selectedDateStr]);

  // Calendar grid
  const calendarDays = useMemo(() => {
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = toLocalDateString(new Date());

    const days: { date: number; dateStr: string; isToday: boolean; isPast: boolean; isSelected: boolean }[] = [];

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
      days.push({
        date: d,
        dateStr,
        isToday: dateStr === today,
        isPast: dateStr < today,
        isSelected: dateStr === selectedDateStr,
      });
    }

    return { days, firstDay, month, year };
  }, [viewMonth, selectedDateStr]);

  return (
    <div className="space-y-3">
      {/* Presets */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const presetDate = new Date(Date.now() + p.hours * 3600_000);
          const isActive = parsed && Math.abs(parsed.getTime() - presetDate.getTime()) < 600_000;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.hours)}
              className={`rounded border px-2.5 py-1 text-[10px] font-mono tracking-wider transition-all duration-snappy ease-snappy ${
                isActive
                  ? (pm?.presetActive ?? "border-primary/30 bg-primary/10 text-primary font-bold")
                  : (pm?.presetInactive ?? "border-border bg-card/30 text-muted-foreground hover:text-foreground hover:border-primary/20")
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Date + Time fields */}
      <div className="flex gap-2">
        {/* Date field / calendar trigger */}
        <button
          id={dateButtonId}
          type="button"
          onClick={() => setShowCalendar(!showCalendar)}
          aria-controls={calendarId}
          aria-expanded={showCalendar}
          aria-haspopup="dialog"
          className={`flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-all duration-snappy ease-snappy ${
            hasError
              ? "border-destructive"
              : showCalendar
                ? pm ? `${pm.fieldBorder} ring-1 ring-slate-400/30` : "border-primary ring-1 ring-primary"
                : pm ? `${pm.fieldBorder} ${pm.fieldHover}` : "border-input hover:border-foreground/20"
          }`}
        >
          <CalendarBlank className={`h-4 w-4 ${pm?.icon ?? "text-muted-foreground"}`} weight="duotone" />
          <span className={selectedDateStr ? (pm?.text ?? "text-foreground") : (pm?.placeholder ?? "text-muted-foreground")}>
            {parsed
              ? parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
              : "Select date"}
          </span>
        </button>

        {/* Time field */}
        <div className={`flex items-center gap-2 rounded-md border px-3 py-2 transition-all duration-snappy ease-snappy ${
          hasError ? "border-destructive" : pm ? `${pm.fieldBorder} ${pm.fieldHover}` : "border-input hover:border-foreground/20"
        }`}>
          <Clock className={`h-4 w-4 ${pm?.icon ?? "text-muted-foreground"}`} weight="duotone" />
          <input
            id={timeInputId}
            type="time"
            value={selectedTime}
            onChange={(e) => handleTimeChange(e.target.value)}
            aria-label="Resolution time"
            className={`bg-transparent text-sm outline-none [color-scheme:dark] ${pm?.text ?? "text-foreground"}`}
          />
        </div>
      </div>

      {/* Calendar dropdown */}
      {showCalendar && (
        <div
          id={calendarId}
          role="dialog"
          aria-label="Choose a resolution date"
          className={`rounded border backdrop-blur-xl p-3 shadow-lg ${pm?.calBg ?? "bg-card/50"}`}
        >
          {/* Month navigation */}
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewMonth(new Date(calendarDays.year, calendarDays.month - 1, 1))}
              className={`rounded p-1 transition-colors ${pm?.calNav ?? "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              <CaretLeft className="h-4 w-4" weight="bold" />
            </button>
            <span className={`text-xs font-mono font-bold tracking-wider ${pm?.text ?? ""}`}>
              {MONTHS[calendarDays.month]} {calendarDays.year}
            </span>
            <button
              type="button"
              onClick={() => setViewMonth(new Date(calendarDays.year, calendarDays.month + 1, 1))}
              className={`rounded p-1 transition-colors ${pm?.calNav ?? "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              <CaretRight className="h-4 w-4" weight="bold" />
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {DAYS.map((d) => (
              <div key={d} className={`py-1 text-[10px] font-medium tracking-wider ${pm?.calHeader ?? "text-muted-foreground"}`}>
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {/* Empty cells for offset */}
            {Array.from({ length: calendarDays.firstDay }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {calendarDays.days.map((day) => (
              <button
                key={day.date}
                type="button"
                disabled={day.isPast}
                onClick={() => {
                  handleDateSelect(day.dateStr);
                  setShowCalendar(false);
                }}
                className={`rounded py-1.5 text-xs transition-all duration-snappy ease-snappy ${
                  day.isSelected
                    ? (pm?.calDaySelected ?? "bg-primary text-white font-medium")
                    : day.isToday
                      ? (pm?.calDayToday ?? "bg-primary/10 text-primary font-medium hover:bg-primary/20")
                      : day.isPast
                        ? (pm?.calDayPast ?? "text-muted-foreground/40 cursor-not-allowed")
                        : (pm?.calDay ?? "text-foreground hover:bg-muted")
                }`}
              >
                {day.date}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Preview */}
      {parsed && (
        <div className={`flex items-center justify-between rounded border px-3 py-2 ${pm?.previewBg ?? "bg-card/30"}`}>
          <span className={`text-[10px] font-mono ${pm?.previewText ?? "text-muted-foreground"}`}>
            {formatDisplay(parsed)}
          </span>
          <span className={`text-[10px] font-mono font-bold ${pm?.previewAccent ?? "text-primary"}`}>
            {formatRelative(parsed)}
          </span>
        </div>
      )}
    </div>
  );
}
