/**
 * SchedulerJobs — the workspace "Background Jobs" admin screen. Lists every
 * hard-coded scheduler job the server declares (cmd/kitpd/main.go), shows each
 * job's properties + last-run status, and offers a per-job "Run now" button
 * that triggers the job synchronously and surfaces the result.
 *
 * Data source is the in-memory scheduler, not the DB: `scheduler.list` (load)
 * and `scheduler.run` (run-now), both admin-only. The last-run status box
 * persists because it reflects the server's own per-job metrics (success /
 * failure counts, last run timestamp + duration + error) — re-fetched on every
 * mount, so it survives navigating away and back as long as the process lives.
 *
 * Zero-promise: every call is `api.callByName(..., onOk, { alive })`, matching
 * the rest of the client.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import {
  ADMIN_SPEC,
  type SchedulerJobInfo,
  type SchedulerListOutput,
  type SchedulerRunOutput,
} from './specs.js';

export interface SchedulerJobsConfig extends BaseControlConfig {
  type: 'SchedulerJobs';
  /** Breadcrumb title (the AppShell reads it for the admin crumb). */
  title?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    SchedulerJobs: SchedulerJobsConfig;
  }
}

export class SchedulerJobs extends Control<SchedulerJobsConfig> {
  /** Loaded jobs (from scheduler.list). */
  private jobs: SchedulerJobInfo[] = [];
  /** False until the first list response lands (drives the loading note). */
  private loaded = false;
  /** Names with an in-flight run-now (disables the button, shows "Running…"). */
  private readonly running = new Set<string>();
  /** Last manual-run outcome per job name — the transient result line. */
  private readonly lastResult: Record<string, SchedulerRunOutput> = {};

  private listHost!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'scheduler-jobs';
    el.dataset.control = 'SchedulerJobs';
    return el;
  }

  protected render(): void {
    const head = document.createElement('header');
    head.className = 'scheduler-jobs__head';
    const title = document.createElement('h1');
    title.className = 'scheduler-jobs__title';
    title.textContent = 'Background Jobs';
    const hint = document.createElement('p');
    hint.className = 'scheduler-jobs__hint muted';
    hint.textContent =
      'The hard-coded periodic jobs this server runs. Use “Run now” to trigger one immediately; the last-run status reflects the server’s live metrics.';
    head.append(title, hint);

    const list = document.createElement('div');
    list.className = 'scheduler-jobs__list';
    list.dataset.jobList = '';
    this.listHost = list;

    this.el.append(head, list);
    this.paint();
    this.load();
  }

  private load(): void {
    this.ctx.api.callByName(
      ADMIN_SPEC.schedulerList,
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.jobs = (out as SchedulerListOutput).jobs ?? [];
        this.loaded = true;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paint(): void {
    const host = this.listHost;
    host.replaceChildren();
    if (!this.loaded) {
      host.append(note('Loading jobs…'));
      return;
    }
    if (this.jobs.length === 0) {
      host.append(note('No background jobs registered.'));
      return;
    }
    for (const j of this.jobs) host.append(this.renderJob(j));
  }

  private renderJob(j: SchedulerJobInfo): HTMLElement {
    const card = document.createElement('article');
    card.className = 'scheduler-jobs__job';
    card.dataset.job = j.name;
    if (j.disabled) card.classList.add('scheduler-jobs__job--disabled');

    // Header: name + optional disabled badge + the run-now button.
    const header = document.createElement('div');
    header.className = 'scheduler-jobs__job-head';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'scheduler-jobs__job-titles';
    const name = document.createElement('h2');
    name.className = 'scheduler-jobs__job-name';
    name.textContent = j.name;
    titleWrap.append(name);
    if (j.disabled) {
      const badge = document.createElement('span');
      badge.className = 'scheduler-jobs__badge scheduler-jobs__badge--disabled';
      badge.textContent = 'disabled';
      titleWrap.append(badge);
    }
    header.append(titleWrap, this.renderRunButton(j));
    card.append(header);

    if (j.description !== '') {
      const desc = document.createElement('p');
      desc.className = 'scheduler-jobs__job-desc muted';
      desc.textContent = j.description;
      card.append(desc);
    }

    card.append(this.renderProps(j));
    card.append(this.renderLastRun(j));
    return card;
  }

  private renderRunButton(j: SchedulerJobInfo): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn scheduler-jobs__run';
    btn.dataset.jobRun = j.name;
    const isRunning = this.running.has(j.name);
    btn.disabled = isRunning;
    btn.textContent = isRunning ? 'Running…' : 'Run now';
    this.listen(btn, 'click', () => this.runNow(j.name));
    return btn;
  }

  private renderProps(j: SchedulerJobInfo): HTMLElement {
    const grid = document.createElement('dl');
    grid.className = 'scheduler-jobs__props';
    const add = (label: string, value: string): void => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      grid.append(dt, dd);
    };
    add('Interval', j.interval || '—');
    add('Timeout', j.timeout || '—');
    add('On startup', j.on_startup ? 'yes' : 'no');
    if (j.offset !== '') add('Offset', j.offset);
    add('Runs', `${j.success} ok · ${j.failure} failed`);
    return grid;
  }

  /** The persistent last-run box: server metrics + the most recent manual run. */
  private renderLastRun(j: SchedulerJobInfo): HTMLElement {
    const box = document.createElement('div');
    box.className = 'scheduler-jobs__status';
    box.dataset.jobStatus = j.name;

    const failed = j.last_error !== '';
    box.classList.add(
      j.last_run_at === ''
        ? 'scheduler-jobs__status--never'
        : failed
          ? 'scheduler-jobs__status--fail'
          : 'scheduler-jobs__status--ok',
    );

    const line = document.createElement('div');
    line.className = 'scheduler-jobs__status-line';
    if (j.last_run_at === '') {
      line.textContent = 'Never run since the server started.';
    } else {
      const parts = [`Last run ${j.last_run_at}`];
      if (j.last_duration !== '') parts.push(j.last_duration);
      parts.push(failed ? 'failed' : 'succeeded');
      line.textContent = parts.join(' · ');
    }
    box.append(line);

    if (j.last_error !== '') {
      const err = document.createElement('div');
      err.className = 'scheduler-jobs__status-error';
      err.textContent = j.last_error;
      box.append(err);
    }

    // The transient outcome of the most recent "Run now" in this session.
    const res = this.lastResult[j.name];
    if (res !== undefined) {
      const note = document.createElement('div');
      note.className = 'scheduler-jobs__run-result muted';
      note.textContent = runResultText(res);
      box.append(note);
    }
    return box;
  }

  private runNow(name: string): void {
    if (this.running.has(name)) return;
    this.running.add(name);
    this.paint();
    this.ctx.api.callByName(
      ADMIN_SPEC.schedulerRun,
      { name },
      (out) => {
        if (!this.isAlive()) return;
        this.running.delete(name);
        const res = out as SchedulerRunOutput;
        this.lastResult[name] = res;
        // Replace the row with the server's refreshed metrics so the
        // last-run box reflects this run's outcome.
        if (res.job.name === name) {
          const idx = this.jobs.findIndex((x) => x.name === name);
          if (idx >= 0) this.jobs[idx] = res.job;
        }
        this.paint();
      },
      {
        alive: () => this.isAlive(),
        // The fault funnel already surfaced the error globally; just clear the
        // in-flight state so the button re-enables.
        onErr: () => {
          if (!this.isAlive()) return;
          this.running.delete(name);
          this.paint();
        },
      },
    );
  }
}

/** Human one-liner for a "Run now" response. */
function runResultText(res: SchedulerRunOutput): string {
  if (!res.started) return res.message || 'Did not run.';
  if (res.ok) return `Ran now in ${res.duration || '—'}.`;
  return `Run failed: ${res.error || 'unknown error'}`;
}

function note(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'scheduler-jobs__empty muted';
  p.textContent = text;
  return p;
}

export function registerSchedulerJobs(): void {
  Control.register('SchedulerJobs', SchedulerJobs);
}
