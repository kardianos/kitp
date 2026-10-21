package kitp.gerrit;

import com.google.gerrit.extensions.common.ChangeInfo;
import com.google.gerrit.extensions.events.ChangeAbandonedListener;
import com.google.gerrit.extensions.events.ChangeEvent;
import com.google.gerrit.extensions.events.ChangeMergedListener;
import com.google.gerrit.extensions.events.ChangeRestoredListener;
import com.google.gerrit.extensions.events.CommentAddedListener;
import com.google.gerrit.extensions.events.RevisionCreatedListener;
import com.google.gerrit.extensions.events.VoteDeletedListener;
import com.google.inject.Inject;
import com.google.inject.Singleton;

/**
 * Every event that can move a change's link — a new change or patch set (new
 * commit message → maybe new tasks), a vote (reviewed / approved), a vote
 * removed, merge, abandon, restore — schedules a sync of that change. The
 * syncer derives the state from the change itself, so the event type doesn't
 * matter beyond "this change may have moved".
 */
@Singleton
class ChangeListener
    implements RevisionCreatedListener,
        CommentAddedListener,
        VoteDeletedListener,
        ChangeMergedListener,
        ChangeAbandonedListener,
        ChangeRestoredListener {
  private final LinkSyncer syncer;

  @Inject
  ChangeListener(LinkSyncer syncer) {
    this.syncer = syncer;
  }

  private void touch(ChangeEvent ev) {
    ChangeInfo c = ev.getChange();
    if (c != null && c.project != null && c._number != null) {
      syncer.schedule(c.project, c._number);
    }
  }

  @Override
  public void onRevisionCreated(RevisionCreatedListener.Event ev) {
    touch(ev);
  }

  @Override
  public void onCommentAdded(CommentAddedListener.Event ev) {
    touch(ev);
  }

  @Override
  public void onVoteDeleted(VoteDeletedListener.Event ev) {
    touch(ev);
  }

  @Override
  public void onChangeMerged(ChangeMergedListener.Event ev) {
    touch(ev);
  }

  @Override
  public void onChangeAbandoned(ChangeAbandonedListener.Event ev) {
    touch(ev);
  }

  @Override
  public void onChangeRestored(ChangeRestoredListener.Event ev) {
    touch(ev);
  }
}
