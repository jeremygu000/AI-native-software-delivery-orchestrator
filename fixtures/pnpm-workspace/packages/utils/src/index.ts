export interface ValueFormatter {
  format(value: string): string;
}

export const formatValue = (value: string): string => value.toUpperCase();
