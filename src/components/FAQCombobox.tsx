import { useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { BaseConhecimento } from '@/types/chat';

interface FAQComboboxProps {
  faqs: BaseConhecimento[];
  onSelectFAQ: (pergunta: string) => void;
  isLoading?: boolean;
}

export function FAQCombobox({ faqs, onSelectFAQ, isLoading }: FAQComboboxProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  const handleSelect = (currentValue: string) => {
    setValue('');
    setOpen(false);
    onSelectFAQ(currentValue);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between h-12 text-left font-normal"
          disabled={isLoading}
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <Search className="h-4 w-4" />
            <span>Pesquisar pergunta frequente...</span>
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0 z-50 bg-popover" align="start">
        <Command>
          <CommandInput placeholder="Escreva para filtrar..." />
          <CommandList>
            <CommandEmpty>Nenhuma pergunta encontrada.</CommandEmpty>
            <CommandGroup>
              {faqs.map((faq) => (
                <CommandItem
                  key={faq.id}
                  value={faq.pergunta}
                  onSelect={handleSelect}
                  className="cursor-pointer"
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === faq.pergunta ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="truncate">{faq.pergunta}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
