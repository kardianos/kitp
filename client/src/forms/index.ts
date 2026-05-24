/**
 * Form kernel — declarative, data-bound form primitives.
 *
 * Usage:
 *   import { Form, TextInput, PasswordInput, Textarea, NumberInput,
 *            Checkbox, SubmitButton, FormErrors } from '@/forms';
 *
 *   <Form spec="activity_sink.set" onSaved={refresh}>
 *     <FormErrors />
 *     <TextInput path="name" />
 *     <PasswordInput path="msgraphClientSecret" />
 *     <SubmitButton />
 *   </Form>
 */

export { default as Form } from './Form.svelte';
export { default as TextInput } from './controls/TextInput.svelte';
export { default as PasswordInput } from './controls/PasswordInput.svelte';
export { default as Textarea } from './controls/Textarea.svelte';
export { default as NumberInput } from './controls/NumberInput.svelte';
export { default as Checkbox } from './controls/Checkbox.svelte';
export { default as Select } from './controls/Select.svelte';
export { default as SubmitButton } from './controls/SubmitButton.svelte';
export { default as FormErrors } from './controls/FormErrors.svelte';
export { getFormContext, tryFormContext } from './context';
export type { FormContext } from './context';
