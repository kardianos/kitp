/**
 * The symbols a watch list's setup offers to pick from (docs/WATCH_LISTS.md).
 * The Symbol field still takes any emoji or character (up to 16); these are
 * the quick picks, in rows of eight: marks, time, state, work, people and
 * colours. `name` is the button's tooltip and accessible name.
 */
export interface WatchSymbol {
  readonly symbol: string;
  readonly name: string;
}

export const WATCH_SYMBOLS: readonly WatchSymbol[] = [
  { symbol: '★', name: 'Star' },
  { symbol: '⭐', name: 'Glowing star' },
  { symbol: '🔖', name: 'Bookmark' },
  { symbol: '📌', name: 'Pin' },
  { symbol: '🚩', name: 'Flag' },
  { symbol: '❗', name: 'Important' },
  { symbol: '❓', name: 'Question' },
  { symbol: '👀', name: 'Watching' },

  { symbol: '⏳', name: 'Waiting' },
  { symbol: '⌛', name: 'Time is up' },
  { symbol: '⏰', name: 'Alarm' },
  { symbol: '📅', name: 'Calendar' },
  { symbol: '🗓️', name: 'Planner' },
  { symbol: '☀️', name: 'Today' },
  { symbol: '🌙', name: 'Tonight' },
  { symbol: '🔁', name: 'Recurring' },

  { symbol: '✅', name: 'Done' },
  { symbol: '☑️', name: 'Check' },
  { symbol: '🔥', name: 'Urgent' },
  { symbol: '⚡', name: 'Quick' },
  { symbol: '🎯', name: 'Goal' },
  { symbol: '🚀', name: 'Launch' },
  { symbol: '🧊', name: 'On ice' },
  { symbol: '🛑', name: 'Blocked' },

  { symbol: '🐛', name: 'Bug' },
  { symbol: '🔧', name: 'Fix' },
  { symbol: '🛠️', name: 'Build' },
  { symbol: '🧪', name: 'Test' },
  { symbol: '💡', name: 'Idea' },
  { symbol: '📝', name: 'Notes' },
  { symbol: '📖', name: 'Read later' },
  { symbol: '📎', name: 'Attached' },

  { symbol: '💬', name: 'Discuss' },
  { symbol: '📧', name: 'Email' },
  { symbol: '📞', name: 'Call' },
  { symbol: '🤝', name: 'Agreed' },
  { symbol: '👍', name: 'Approve' },
  { symbol: '❤️', name: 'Favourite' },
  { symbol: '🙋', name: 'Ask' },
  { symbol: '🎉', name: 'Celebrate' },

  { symbol: '🔴', name: 'Red' },
  { symbol: '🟠', name: 'Orange' },
  { symbol: '🟡', name: 'Yellow' },
  { symbol: '🟢', name: 'Green' },
  { symbol: '🔵', name: 'Blue' },
  { symbol: '🟣', name: 'Purple' },
  { symbol: '⚫', name: 'Black' },
  { symbol: '⚪', name: 'White' },
];
