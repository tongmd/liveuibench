import { CompleteAppBrowser as RuntimeBrowser } from '../../liveuiagent/server/complete-app-evaluator.js';
import { planFormSubmission } from './form-submission.js';

// Keep the runtime's sandbox, storage bridge and observed host responses.
export class CompleteAppBrowser extends RuntimeBrowser {
  override async snapshot(name?: string) {
    const snapshot = await super.snapshot(name);
    const details = await this.frame!.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-liveui-eval-id]')).map(node => ({
      target: node.getAttribute('data-liveui-eval-id')!, required: Boolean(node.required), inputName:node.name, inputId:node.id,
      label: node.getAttribute('aria-label') || Array.from(node.labels || []).map(label => {const copy=label.cloneNode(true) as HTMLElement;copy.querySelectorAll('input,textarea,select,button').forEach(control=>control.remove());return copy.textContent?.trim() || '';}).join(' ').trim() || node.getAttribute('placeholder') || node.name || node.id,
      options: node instanceof HTMLSelectElement ? Array.from(node.options).filter(option => !option.disabled).map(option => ({value:option.value,label:option.textContent?.trim() || ''})) : undefined,
    })));
    return {...snapshot, fields:snapshot.fields.map(field => ({...field,...details.find(detail => detail.target === field.target)}))};
  }
  private async actionButton(snapshot: Awaited<ReturnType<CompleteAppBrowser['snapshot']>>, ordinal: number) {
    const buttons = snapshot.buttons.filter(button => !button.disabled);
    const boundTarget = await this.frame!.evaluate(visibleTargets => {
      const bindings = Array.from(document.querySelectorAll<HTMLElement>('[data-liveui-action="agent.invoke"]'));
      if (!bindings.length) return null;
      const visible = new Set(visibleTargets);
      const candidates = new Set<string>();
      for (const binding of bindings) {
        const controls = binding instanceof HTMLFormElement ? Array.from(binding.elements) : [binding];
        for (const control of controls) {
          const target = control.getAttribute('data-liveui-eval-id');
          const box = control.getBoundingClientRect();
          const style = getComputedStyle(control);
          if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' || (control as HTMLButtonElement).disabled) continue;
          if (target && visible.has(target)) candidates.add(target);
        }
      }
      if (candidates.size !== 1) throw Error(`Ambiguous or unavailable agent.invoke binding: ${candidates.size} visible actions`);
      return [...candidates][0];
    }, buttons.map(button => button.target));
    if (!Number.isInteger(ordinal) || ordinal < 1 || (boundTarget !== null && ordinal !== 1)) throw Error(`No visible action ordinal ${ordinal}`);
    const button = boundTarget === null ? buttons[ordinal - 1] : buttons.find(button => button.target === boundTarget);
    if (!button) throw Error(`No visible action ordinal ${ordinal}`);
    return {button, explicitlyBound:boundTarget !== null};
  }
  override async submit(message: string, ordinal = 1) {
    this.bridgeResults = [];
    const before = await this.snapshot();
    const selected = await this.actionButton(before, ordinal);
    const selectedButton = selected.button;
    const formTargets = await this.frame!.evaluate(target => {
      const button = Array.from(document.querySelectorAll<HTMLElement>('[data-liveui-eval-id]')).find(node => node.getAttribute('data-liveui-eval-id') === target);
      if (!button) throw Error('Selected action disappeared before form mapping');
      const form = (button as HTMLButtonElement | HTMLInputElement).form;
      // Native form ownership includes controls outside the form linked by form=.
      return form ? Array.from(form.elements).map(control => control.getAttribute('data-liveui-eval-id')).filter((id): id is string => Boolean(id)) : null;
    }, selectedButton.target);
    const fields = formTargets === null ? before.fields : before.fields.filter(field => formTargets.includes(field.target));
    const plan = planFormSubmission(fields, message, {explicitlyBound:selected.explicitlyBound});
    // Validate the whole plan before touching controls; ambiguous input is a failure.
    for (const step of plan) await this.perform(step);
    const ready = await this.actionButton(await this.snapshot(), ordinal);
    if (ready.explicitlyBound !== selected.explicitlyBound) throw Error('Action binding changed during form entry');
    const button = ready.button;
    await this.perform({kind:'click',target:button.target});
    // Allow the app's AI continuation to enqueue its storage write before capture.
    await this.settle();
    return {selection:{fields:plan.map(step => before.fields.find(field => field.target === step.target)!.label),button:button.label},bridgeResults:JSON.parse(JSON.stringify(this.bridgeResults)),gui:await this.snapshot()};
  }
}
