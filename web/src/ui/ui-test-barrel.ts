/**
 * Test-only barrel for the anchored-UI primitives. Bundles Popover + the two
 * controls together with the Control core so `node --test` drives them through
 * ONE shared Control singleton (same reasoning as src/test-barrel.ts). Not
 * imported by the app — main.ts imports the modules directly.
 */

export { Control } from '../core/control.js';
export type { ControlContext } from '../core/control.js';
export { Popover } from './popover.js';
export type { PopoverOptions, Placement } from './popover.js';
export {
  Combobox,
  registerCombobox,
  type ComboboxConfig,
  type ComboboxOption,
  type ComboboxLoad,
} from './combobox.js';
export { DatePicker, registerDatePicker, type DatePickerConfig } from './datepicker.js';
export { RefPicker, registerRefPicker, type RefPickerConfig } from './ref-picker.js';
export {
  registerCardSearchSpec,
  CARD_SEARCH_SPEC,
  type CardSearchInput,
  type CardSearchOutput,
  type CardSearchRow,
} from './specs.js';
export { Api } from '../core/api.js';
export { Dispatcher } from '../core/dispatch.js';
export type { Transport } from '../core/dispatch.js';
export { tree } from '../core/tree.js';
