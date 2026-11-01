/**
 * NewPageButton — the "+ New page" action on a `pages` screen's filter bar
 * (mounted through the ScreenFilterBar `viewActions` seam; which layouts get
 * it is data-driven in `viewActionsForLayout`, not branched here).
 *
 * A click creates an "Untitled page" at the top of the active project's page
 * tree (`card.insert`, card_type `page`; the server gives it the project's
 * publish_status flow default — Draft) and opens it, where the title, slug
 * and body are edited in place. Child pages are added from a page's detail.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { PROJECT_SPEC, type CardInsertOutput } from '../projects/specs.js';
import { navigate, pageUrl } from '../shell/router.js';

export interface NewPageButtonConfig extends BaseControlConfig {
  type: 'NewPageButton';
  /** Button label. Default '+ New page'. */
  label?: string;
  /** Title the new page starts with. Default 'Untitled page'. */
  initialTitle?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    NewPageButton: NewPageButtonConfig;
  }
}

/** The card.insert input for a new page under `parentId` (a project or page). */
export function newPageInput(parentId: bigint, title: string): {
  cardTypeName: string;
  parentCardId: bigint;
  title: string;
} {
  return { cardTypeName: 'page', parentCardId: parentId, title };
}

export class NewPageButton extends Control<NewPageButtonConfig> {
  protected override createRoot(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary filterbar__new';
    btn.dataset.control = 'NewPageButton';
    btn.dataset.newPage = '';
    btn.textContent = this.config.label ?? '+ New page';
    return btn;
  }

  protected render(): void {
    const btn = this.el as HTMLButtonElement;
    this.listen(btn, 'click', () => {
      const project = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | string | null>();
      if (project === null || project === undefined) return;
      btn.disabled = true;
      this.ctx.api.callByName(
        PROJECT_SPEC.cardInsert,
        newPageInput(BigInt(project), this.config.initialTitle ?? 'Untitled page'),
        (out) => {
          btn.disabled = false;
          navigate(pageUrl((out as CardInsertOutput).id));
        },
        {
          alive: () => this.isAlive(),
          onErr: () => {
            btn.disabled = false;
          },
        },
      );
    });
  }
}

export function registerNewPageButton(): void {
  Control.register('NewPageButton', NewPageButton);
}
