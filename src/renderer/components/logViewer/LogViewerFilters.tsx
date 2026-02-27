import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Search, X, Copy, Check } from 'lucide-react';
import { useLogViewerStore, selectFilteredEntries, type FilterState } from '@/stores/logViewerStore';
import type { LogCategory, LogLevel } from '../../../main/types/logger';

const CATEGORIES: LogCategory[] = [
  'ai-sdk',
  'mcp',
  'database',
  'ipc',
  'preferences',
  'models',
  'core',
  'analytics',
  'oauth',
];

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

interface LogViewerFiltersProps {
  filters: FilterState;
  onFilterChange: (filters: Partial<FilterState>) => void;
  autoScroll: boolean;
  onAutoScrollChange: () => void;
  onClear: () => void;
}

/**
 * Filter controls for log viewer
 */
export function LogViewerFilters({
  filters,
  onFilterChange,
  autoScroll,
  onAutoScrollChange,
  onClear,
}: LogViewerFiltersProps) {
  const [searchInput, setSearchInput] = useState(filters.searchTerm);
  const [copied, setCopied] = useState(false);

  const handleCopyLogs = () => {
    const filteredEntries = selectFilteredEntries(useLogViewerStore.getState());
    const text = filteredEntries
      .map((entry) => {
        const ts = entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp);
        const time = ts.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(ts.getMilliseconds()).padStart(3, '0');
        const header = `[${time}] [${entry.category}] [${entry.level.toUpperCase()}] ${entry.message}`;
        if (entry.context && Object.keys(entry.context).length > 0) {
          return header + '\n' + JSON.stringify(entry.context, null, 2);
        }
        return header;
      })
      .join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      onFilterChange({ searchTerm: searchInput });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, onFilterChange]);

  const toggleCategory = (category: LogCategory) => {
    const newCategories = new Set(filters.categories);
    if (newCategories.has(category)) {
      newCategories.delete(category);
    } else {
      newCategories.add(category);
    }
    onFilterChange({ categories: newCategories });
  };

  const toggleLevel = (level: LogLevel) => {
    const newLevels = new Set(filters.levels);
    if (newLevels.has(level)) {
      newLevels.delete(level);
    } else {
      newLevels.add(level);
    }
    onFilterChange({ levels: newLevels });
  };

  return (
    <div className="space-y-4 rounded-lg border p-4 bg-muted/50">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search logs..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-9 pr-9"
        />
        {searchInput && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setSearchInput('')}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Categories */}
      <div>
        <Label className="text-sm font-medium mb-2 block">Categories</Label>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((category) => (
            <Badge
              key={category}
              variant={filters.categories.has(category) ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => toggleCategory(category)}
            >
              {category}
            </Badge>
          ))}
        </div>
      </div>

      {/* Levels */}
      <div>
        <Label className="text-sm font-medium mb-2 block">Levels</Label>
        <div className="flex gap-2">
          {LEVELS.map((level) => (
            <Button
              key={level}
              variant={filters.levels.has(level) ? 'default' : 'outline'}
              size="sm"
              onClick={() => toggleLevel(level)}
            >
              {level.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Checkbox
            id="auto-scroll"
            checked={autoScroll}
            onCheckedChange={onAutoScrollChange}
          />
          <Label htmlFor="auto-scroll" className="text-sm cursor-pointer">
            Auto-scroll
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCopyLogs}>
            {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
            {copied ? 'Copied!' : 'Copy Logs'}
          </Button>
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear Logs
          </Button>
        </div>
      </div>
    </div>
  );
}
