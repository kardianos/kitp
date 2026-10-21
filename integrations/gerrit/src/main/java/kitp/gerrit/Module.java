package kitp.gerrit;

import com.google.gerrit.extensions.events.ChangeAbandonedListener;
import com.google.gerrit.extensions.events.ChangeMergedListener;
import com.google.gerrit.extensions.events.ChangeRestoredListener;
import com.google.gerrit.extensions.events.CommentAddedListener;
import com.google.gerrit.extensions.events.RevisionCreatedListener;
import com.google.gerrit.extensions.events.VoteDeletedListener;
import com.google.gerrit.extensions.registration.DynamicSet;
import com.google.gerrit.lifecycle.LifecycleModule;

/** Gerrit-Module: wires the change listeners and the link syncer's worker. */
public class Module extends LifecycleModule {
  @Override
  protected void configure() {
    DynamicSet.bind(binder(), RevisionCreatedListener.class).to(ChangeListener.class);
    DynamicSet.bind(binder(), CommentAddedListener.class).to(ChangeListener.class);
    DynamicSet.bind(binder(), VoteDeletedListener.class).to(ChangeListener.class);
    DynamicSet.bind(binder(), ChangeMergedListener.class).to(ChangeListener.class);
    DynamicSet.bind(binder(), ChangeAbandonedListener.class).to(ChangeListener.class);
    DynamicSet.bind(binder(), ChangeRestoredListener.class).to(ChangeListener.class);
    listener().to(LinkSyncer.class);
  }
}
