// The curated emoji set for the offline picker (B). Hand-built and deliberately small: this is a
// messenger's quick picker, not a Unicode browser.
//
// NO DEPENDENCY, NO CDN, NO NETWORK. An emoji-mart-style package ships a multi-megabyte index and,
// in most setups, fetches sprite sheets from a CDN — which for Caravel would mean a third party
// learning that this browser opened a chat composer, on a page whose entire point is that no third
// party learns anything. A hand-kept list costs a screenful of data and leaks nothing.
//
// GLYPHS COME FROM THE OS FONT, so what renders is not ours to control. The set is therefore biased
// toward emoji standardised in 2016 or earlier (Unicode ≤ 9.0), which every platform still in use
// has shipped for years; a handful of later favourites are included where their absence would be
// more surprising than a rare tofu box (F12). Bundling a font to close that gap would cost more
// than the whole feature.
//
// `keywords` are what the search box matches on — lowercase, ASCII, no punctuation. They are
// written for RECALL, not for taxonomy: the words someone types when they want that emoji, which is
// why several entries carry slang ("lol", "fire", "shrug") alongside the literal name.

export interface EmojiEntry {
  char: string
  keywords: string[]
}

export interface EmojiCategory {
  name: string
  emoji: EmojiEntry[]
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    name: 'Smileys',
    emoji: [
      { char: '😀', keywords: ['grin', 'smile', 'happy'] },
      { char: '😃', keywords: ['smile', 'happy', 'joy'] },
      { char: '😄', keywords: ['smile', 'happy', 'laugh'] },
      { char: '😁', keywords: ['grin', 'beam', 'smile'] },
      { char: '😆', keywords: ['laugh', 'lol', 'squint'] },
      { char: '😅', keywords: ['sweat', 'laugh', 'relief', 'phew', 'nervous', 'awkward'] },
      { char: '😂', keywords: ['laugh', 'lol', 'cry', 'tears', 'funny'] },
      { char: '🙂', keywords: ['smile', 'slight', 'ok'] },
      { char: '😉', keywords: ['wink', 'flirt'] },
      { char: '😊', keywords: ['blush', 'smile', 'happy'] },
      { char: '😍', keywords: ['love', 'eyes', 'crush', 'adore'] },
      { char: '😘', keywords: ['kiss', 'love', 'blow'] },
      { char: '😋', keywords: ['yum', 'tongue', 'tasty', 'delicious'] },
      { char: '😎', keywords: ['cool', 'sunglasses', 'shades'] },
      { char: '🤩', keywords: ['star', 'struck', 'wow', 'excited'] },
      { char: '🤔', keywords: ['think', 'hmm', 'consider', 'doubt'] },
      { char: '🤨', keywords: ['eyebrow', 'skeptical', 'suspicious'] },
      { char: '😐', keywords: ['neutral', 'meh', 'blank'] },
      { char: '🙄', keywords: ['eyeroll', 'roll', 'annoyed', 'whatever'] },
      { char: '😴', keywords: ['sleep', 'tired', 'zzz', 'bored'] },
      { char: '😇', keywords: ['angel', 'innocent', 'halo'] },
      { char: '🤯', keywords: ['mind', 'blown', 'explode', 'shock'] },
      { char: '😢', keywords: ['cry', 'sad', 'tear', 'upset'] },
      { char: '😭', keywords: ['sob', 'cry', 'bawl', 'sad'] },
      { char: '😳', keywords: ['flushed', 'embarrassed', 'blush', 'shock'] },
      { char: '😱', keywords: ['scream', 'fear', 'shock', 'horror'] },
      { char: '😮', keywords: ['wow', 'open', 'mouth', 'surprise', 'gasp'] },
      { char: '😬', keywords: ['grimace', 'awkward', 'eek', 'yikes'] },
      { char: '😤', keywords: ['huff', 'triumph', 'steam', 'determined'] },
      { char: '😡', keywords: ['angry', 'mad', 'rage', 'furious'] },
      { char: '🥺', keywords: ['pleading', 'puppy', 'please', 'beg'] },
      { char: '🤗', keywords: ['hug', 'embrace', 'welcome'] },
      { char: '🤫', keywords: ['shh', 'quiet', 'secret', 'hush'] },
      { char: '🤥', keywords: ['lie', 'pinocchio', 'liar'] },
      { char: '😶', keywords: ['speechless', 'silent', 'blank', 'quiet'] },
      { char: '🤐', keywords: ['zip', 'sealed', 'secret', 'quiet'] },
      { char: '😷', keywords: ['mask', 'sick', 'ill'] },
      { char: '🤒', keywords: ['sick', 'fever', 'ill', 'thermometer'] },
      { char: '🥳', keywords: ['party', 'celebrate', 'birthday', 'hooray'] },
    ],
  },
  {
    name: 'Gestures',
    emoji: [
      { char: '👍', keywords: ['thumbsup', 'yes', 'ok', 'good', 'like', 'approve'] },
      { char: '👎', keywords: ['thumbsdown', 'no', 'bad', 'dislike'] },
      { char: '👌', keywords: ['ok', 'perfect', 'nice'] },
      { char: '✌️', keywords: ['peace', 'victory', 'two'] },
      { char: '🤞', keywords: ['fingers', 'crossed', 'luck', 'hope'] },
      { char: '🤝', keywords: ['handshake', 'deal', 'agree', 'shake'] },
      { char: '👏', keywords: ['clap', 'applause', 'bravo', 'well done'] },
      { char: '🙌', keywords: ['raise', 'hands', 'praise', 'hooray', 'celebrate'] },
      { char: '🙏', keywords: ['pray', 'thanks', 'please', 'namaste', 'hope'] },
      { char: '💪', keywords: ['muscle', 'strong', 'flex', 'power'] },
      { char: '👋', keywords: ['wave', 'hi', 'hello', 'bye', 'goodbye'] },
      { char: '🤙', keywords: ['callme', 'shaka', 'hang', 'loose'] },
      { char: '✊', keywords: ['fist', 'solidarity', 'power'] },
      { char: '👊', keywords: ['punch', 'fist', 'bump', 'bro'] },
      { char: '☝️', keywords: ['point', 'up', 'one', 'index'] },
      { char: '👇', keywords: ['point', 'down', 'below'] },
      { char: '👆', keywords: ['point', 'up', 'above'] },
      { char: '👉', keywords: ['point', 'right', 'this'] },
      { char: '👈', keywords: ['point', 'left'] },
      { char: '🤷', keywords: ['shrug', 'dunno', 'idk', 'whatever'] },
      { char: '🤦', keywords: ['facepalm', 'ugh', 'disbelief'] },
      { char: '💁', keywords: ['info', 'sassy', 'tipping', 'hand'] },
      { char: '🙋', keywords: ['raise', 'hand', 'me', 'question', 'here'] },
      { char: '👀', keywords: ['eyes', 'look', 'watch', 'see', 'sus'] },
    ],
  },
  {
    name: 'Hearts',
    emoji: [
      { char: '❤️', keywords: ['heart', 'love', 'red'] },
      { char: '🧡', keywords: ['heart', 'orange'] },
      { char: '💛', keywords: ['heart', 'yellow'] },
      { char: '💚', keywords: ['heart', 'green'] },
      { char: '💙', keywords: ['heart', 'blue'] },
      { char: '💜', keywords: ['heart', 'purple'] },
      { char: '🖤', keywords: ['heart', 'black'] },
      { char: '💔', keywords: ['broken', 'heart', 'sad', 'breakup'] },
      { char: '💕', keywords: ['hearts', 'love', 'two'] },
      { char: '💖', keywords: ['sparkling', 'heart', 'love'] },
      { char: '💯', keywords: ['hundred', 'perfect', 'score', 'agree'] },
      { char: '✨', keywords: ['sparkles', 'shiny', 'magic', 'nice'] },
    ],
  },
  {
    name: 'Animals',
    emoji: [
      { char: '🐶', keywords: ['dog', 'puppy', 'pet'] },
      { char: '🐱', keywords: ['cat', 'kitten', 'pet'] },
      { char: '🐭', keywords: ['mouse'] },
      { char: '🐰', keywords: ['rabbit', 'bunny'] },
      { char: '🦊', keywords: ['fox'] },
      { char: '🐻', keywords: ['bear'] },
      { char: '🐼', keywords: ['panda'] },
      { char: '🐨', keywords: ['koala'] },
      { char: '🦁', keywords: ['lion'] },
      { char: '🐮', keywords: ['cow'] },
      { char: '🐷', keywords: ['pig'] },
      { char: '🐸', keywords: ['frog'] },
      { char: '🐵', keywords: ['monkey'] },
      { char: '🐔', keywords: ['chicken'] },
      { char: '🐧', keywords: ['penguin'] },
      { char: '🐢', keywords: ['turtle', 'slow'] },
      { char: '🐝', keywords: ['bee', 'honey'] },
      { char: '🦄', keywords: ['unicorn', 'magic'] },
      { char: '🐙', keywords: ['octopus'] },
      { char: '🐳', keywords: ['whale', 'ocean'] },
    ],
  },
  {
    name: 'Food',
    emoji: [
      { char: '🍎', keywords: ['apple', 'fruit', 'red'] },
      { char: '🍌', keywords: ['banana', 'fruit'] },
      { char: '🍓', keywords: ['strawberry', 'fruit', 'berry'] },
      { char: '🍉', keywords: ['watermelon', 'fruit', 'summer'] },
      { char: '🥑', keywords: ['avocado', 'toast'] },
      { char: '🍞', keywords: ['bread', 'toast', 'loaf'] },
      { char: '🧀', keywords: ['cheese'] },
      { char: '🍕', keywords: ['pizza', 'slice', 'food'] },
      { char: '🍔', keywords: ['burger', 'hamburger', 'food'] },
      { char: '🌮', keywords: ['taco', 'mexican'] },
      { char: '🍣', keywords: ['sushi', 'japanese', 'fish'] },
      { char: '🍜', keywords: ['ramen', 'noodles', 'soup'] },
      { char: '🍰', keywords: ['cake', 'dessert', 'slice'] },
      { char: '🎂', keywords: ['birthday', 'cake', 'celebrate'] },
      { char: '🍪', keywords: ['cookie', 'biscuit'] },
      { char: '🍫', keywords: ['chocolate', 'candy'] },
      { char: '☕', keywords: ['coffee', 'tea', 'hot', 'drink'] },
      { char: '🍺', keywords: ['beer', 'drink', 'pub', 'cheers'] },
      { char: '🍷', keywords: ['wine', 'drink', 'red'] },
      { char: '🥂', keywords: ['cheers', 'toast', 'celebrate', 'champagne'] },
    ],
  },
  {
    name: 'Activity',
    emoji: [
      { char: '⚽', keywords: ['football', 'soccer', 'ball'] },
      { char: '🏀', keywords: ['basketball', 'ball'] },
      { char: '🎾', keywords: ['tennis', 'ball'] },
      { char: '🏆', keywords: ['trophy', 'win', 'award', 'champion'] },
      { char: '🥇', keywords: ['gold', 'medal', 'first', 'win'] },
      { char: '🎯', keywords: ['target', 'bullseye', 'dart', 'goal'] },
      { char: '🎮', keywords: ['game', 'gaming', 'controller', 'play'] },
      { char: '🎲', keywords: ['dice', 'game', 'random', 'luck'] },
      { char: '🎸', keywords: ['guitar', 'music', 'rock'] },
      { char: '🎵', keywords: ['music', 'note', 'song'] },
      { char: '🎉', keywords: ['party', 'celebrate', 'tada', 'congrats'] },
      { char: '🎁', keywords: ['gift', 'present', 'birthday'] },
      { char: '🏃', keywords: ['run', 'running', 'exercise'] },
      { char: '🚴', keywords: ['bike', 'cycling', 'ride'] },
    ],
  },
  {
    name: 'Places',
    emoji: [
      { char: '🚀', keywords: ['rocket', 'launch', 'space', 'ship', 'fast'] },
      { char: '✈️', keywords: ['plane', 'flight', 'travel', 'fly'] },
      { char: '🚗', keywords: ['car', 'drive', 'auto'] },
      { char: '🚲', keywords: ['bike', 'bicycle', 'cycle'] },
      { char: '🏠', keywords: ['house', 'home', 'building'] },
      { char: '🏢', keywords: ['office', 'building', 'work'] },
      { char: '🌍', keywords: ['earth', 'world', 'globe', 'planet'] },
      { char: '🌙', keywords: ['moon', 'night', 'crescent'] },
      { char: '⭐', keywords: ['star', 'favourite', 'favorite'] },
      { char: '☀️', keywords: ['sun', 'sunny', 'weather', 'hot'] },
      { char: '🌧️', keywords: ['rain', 'weather', 'wet'] },
      { char: '❄️', keywords: ['snow', 'snowflake', 'cold', 'winter'] },
      { char: '🔥', keywords: ['fire', 'hot', 'lit', 'flame', 'burn'] },
      { char: '🌊', keywords: ['wave', 'ocean', 'sea', 'water'] },
      { char: '🌈', keywords: ['rainbow', 'pride', 'colour', 'color'] },
      { char: '🌸', keywords: ['blossom', 'flower', 'cherry', 'spring'] },
    ],
  },
  {
    name: 'Objects',
    emoji: [
      { char: '💻', keywords: ['laptop', 'computer', 'work', 'code'] },
      { char: '📱', keywords: ['phone', 'mobile', 'cell'] },
      { char: '📷', keywords: ['camera', 'photo', 'picture'] },
      { char: '🔑', keywords: ['key', 'lock', 'password', 'access'] },
      { char: '🔒', keywords: ['lock', 'locked', 'secure', 'private'] },
      { char: '💰', keywords: ['money', 'bag', 'cash', 'rich'] },
      { char: '💸', keywords: ['money', 'flying', 'spend', 'cash'] },
      { char: '📌', keywords: ['pin', 'pinned', 'note'] },
      { char: '📎', keywords: ['clip', 'attach', 'paperclip', 'file'] },
      { char: '📝', keywords: ['note', 'memo', 'write', 'edit'] },
      { char: '📚', keywords: ['books', 'read', 'study', 'library'] },
      { char: '⏰', keywords: ['alarm', 'clock', 'time', 'wake'] },
      { char: '🔔', keywords: ['bell', 'notify', 'alert', 'ring'] },
      { char: '💡', keywords: ['idea', 'bulb', 'light', 'think'] },
      { char: '🔍', keywords: ['search', 'find', 'magnify', 'look'] },
      { char: '🛠️', keywords: ['tools', 'fix', 'build', 'repair'] },
    ],
  },
  {
    name: 'Symbols',
    emoji: [
      { char: '✅', keywords: ['check', 'done', 'tick', 'yes', 'ok'] },
      { char: '❌', keywords: ['cross', 'no', 'wrong', 'cancel', 'x'] },
      { char: '⚠️', keywords: ['warning', 'caution', 'alert'] },
      { char: '❓', keywords: ['question', 'what', 'ask', 'huh'] },
      { char: '❗', keywords: ['exclamation', 'important', 'alert'] },
      { char: '➕', keywords: ['plus', 'add', 'more'] },
      { char: '➖', keywords: ['minus', 'subtract', 'less'] },
      { char: '♻️', keywords: ['recycle', 'green', 'reuse'] },
      { char: '🔗', keywords: ['link', 'url', 'chain'] },
      { char: '💬', keywords: ['speech', 'chat', 'message', 'comment', 'talk'] },
      { char: '👁️', keywords: ['eye', 'see', 'watch', 'look'] },
      { char: '🕐', keywords: ['clock', 'time', 'hour', 'later'] },
    ],
  },
]

// The six on the reaction quick-set row (C). Chosen for coverage of the ordinary replies — agree,
// love, funny, surprise, sympathy, thanks — rather than for frequency in any particular corpus.
// Lives here rather than in ReactionQuickSet.tsx so it sits beside the set it must be a subset of:
// every one of these is in the categories above, which is what lets the "+" picker reach them too,
// and is asserted in emojiSearch.test.ts.
export const QUICK_SET: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏']

// Flat view — what search runs over, built once at module load rather than per keystroke.
export const ALL_EMOJI: EmojiEntry[] = EMOJI_CATEGORIES.flatMap(c => c.emoji)
