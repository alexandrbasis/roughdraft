import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
} from "./components/ui/select";
import {
  getThemePreference,
  setThemePreference,
  subscribeToTheme,
} from "./theme";

const options = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

export function ThemeSwitcher() {
  const preference = useSyncExternalStore(subscribeToTheme, getThemePreference);
  const selected =
    options.find((option) => option.value === preference) ?? options[0];
  const Icon = selected.icon;

  return (
    <div className="fixed bottom-3 left-3 z-40">
      <Select
        value={preference}
        onValueChange={(value) => {
          if (value === "system" || value === "light" || value === "dark") {
            setThemePreference(value);
          }
        }}
      >
        <SelectTrigger
          data-testid="theme-menu-trigger"
          aria-label="Appearance"
          title="Appearance"
          className="min-h-10 gap-2 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground shadow-sm"
        >
          <Icon className="size-4" aria-hidden="true" />
          {selected.label}
        </SelectTrigger>
        <SelectContent side="top" align="start">
          {options.map(({ value, label, icon: OptionIcon }) => (
            <SelectItem
              key={value}
              value={value}
              data-testid={`theme-option-${value}`}
              className="min-h-9"
            >
              <OptionIcon className="size-4" aria-hidden="true" />
              <SelectItemText>{label}</SelectItemText>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
