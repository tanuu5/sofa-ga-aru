// 画面の文字（日本語／英語）とオーバーレイ
import { withGlyphs } from './glyphs.js';

const STR = {
  ja: {
    docTitle: 'ソファーがある。',
    title: 'ソファーがある。',
    sub: 'there is a sofa.',
    welcome: 'おかえりなさい。',
    start: 'クリックしてはじめる',
    startTouch: 'タップしてはじめる',
    startPad: '{south}　ではじめる',
    note: 'ヘッドホン推奨　／　約10分',
    controls: 'WASD・マウス　歩く・見回す<br>E・クリック　座る・立つ<br>Esc　一時停止',
    controlsTouch: '左側をなぞって歩く　右側をなぞって見回す',
    controlsPad: '{ls}　歩く　　{rs}　見回す<br>{south}　座る・立つ　　{start}　一時停止',
    loading: '準備しています…',
    sit: '座る',
    stand: '立つ',
    moveHint: 'WASD で歩く　マウスで見回す',
    moveHintTouch: '左側をなぞって歩く',
    moveHintPad: '{ls}　で歩く　　{rs}　で見回す',
    paused: '一時停止',
    resume: 'クリックで戻る',
    resumeTouch: 'タップで戻る',
    resumePad: '{start}　で戻る',
    continue: 'つづける',
    volume: '音量',
    sens: '視点の感度',
    bob: '歩くときの揺れ',
    invert: '視点の上下反転',
    rumble: '振動',
    padType: 'ボタン表示',
    padAuto: '自動',
    restart: '最初から',
    music1: '……どこかで、音楽が鳴っている。',
    music3: '音楽が聞こえる。',
    ending: 'ソファーがある。',
    endSub: 'おしまい',
    credit: '企画　たぬ　　制作　Claude',
    again: 'もう一度',
    stay: 'ここにいる',
    audioNotice: 'クリックすると音が鳴ります',
    noWebGL: 'このブラウザでは WebGL2 が使えないため、表示できません。',
  },
  en: {
    docTitle: 'There Is a Sofa.',
    title: 'ソファーがある。',
    sub: 'there is a sofa.',
    welcome: 'welcome back.',
    start: 'click to begin',
    startTouch: 'tap to begin',
    startPad: 'press {south} to begin',
    note: 'headphones recommended / about 10 minutes',
    controls: 'WASD · mouse — walk · look<br>E · click — sit · stand<br>Esc — pause',
    controlsTouch: 'drag left side to walk, right side to look',
    controlsPad: '{ls} walk　{rs} look<br>{south} sit · stand　{start} pause',
    loading: 'preparing…',
    sit: 'sit',
    stand: 'stand up',
    moveHint: 'WASD to walk, mouse to look',
    moveHintTouch: 'drag the left side to walk',
    moveHintPad: '{ls} to walk　{rs} to look',
    paused: 'paused',
    resume: 'click to return',
    resumeTouch: 'tap to return',
    resumePad: 'press {start} to return',
    continue: 'continue',
    volume: 'volume',
    sens: 'look sensitivity',
    bob: 'head bob',
    invert: 'invert look',
    rumble: 'vibration',
    padType: 'button icons',
    padAuto: 'auto',
    restart: 'start over',
    music1: '…somewhere, music is playing.',
    music3: 'you can hear the music.',
    ending: 'there is a sofa.',
    endSub: 'the end',
    credit: 'concept — tanu　·　made by Claude',
    again: 'again',
    stay: 'stay here',
    audioNotice: 'click to enable sound',
    noWebGL: 'WebGL2 is not available in this browser.',
  },
};

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(isTouch) {
    // ?lang=ja / ?lang=en で指定できる。なければブラウザの言語で決める
    const q = new URLSearchParams(location.search).get('lang');
    const lang = q === 'ja' || q === 'en' ? q : (navigator.language || 'ja').toLowerCase().startsWith('ja') ? 'ja' : 'en';
    this.lang = lang;
    this.t = STR[lang];
    this.isTouch = isTouch;
    this.device = isTouch ? 'touch' : 'kbm';
    this.padType = 'type2';
    document.documentElement.lang = lang;
    document.title = this.t.docTitle;
    const t = this.t;
    $('t-title').textContent = t.title;
    $('t-sub').textContent = t.sub;
    $('t-welcome').textContent = t.welcome;
    $('t-note').textContent = t.note;
    $('loading-text').textContent = t.loading;
    $('p-title').textContent = t.paused;
    $('resumeBtn').textContent = t.continue;
    $('l-volume').textContent = t.volume;
    $('l-sens').textContent = t.sens;
    $('l-bob').textContent = t.bob;
    $('l-invert').textContent = t.invert;
    $('l-rumble').textContent = t.rumble;
    $('l-padtype').textContent = t.padType;
    $('pt-auto').textContent = t.padAuto;
    $('restart').textContent = t.restart;
    $('e-title').textContent = t.ending;
    $('e-sub').textContent = t.endSub;
    $('e-credit').textContent = t.credit;
    $('again').textContent = t.again;
    $('stay').textContent = t.stay;
    $('audio-notice').textContent = t.audioNotice;
    this.prompt = $('prompt');
    this.promptLabel = $('prompt-label');
    this.promptKey = $('prompt-key');
    this.caption = $('caption');
    this.hintEl = $('hint');
    this.act = $('act');
    this.promptKind = null;
    this.capTimer = 0;
    this.hintTimer = 0;
    this.hintKind = null;
    if (isTouch) document.body.classList.add('touch');
    this.refresh();
  }

  // 操作の種類（キーボード／タッチ／ゲームパッド）に合わせて表示を切り替える
  setInputMode(device, padType) {
    this.device = device;
    this.padType = padType;
    document.body.classList.toggle('pad', device === 'pad');
    this.refresh();
  }

  fmt(key) {
    return withGlyphs(this.t[key] ?? key, this.padType);
  }

  refresh() {
    const t = this.t;
    const d = this.device;
    if (d === 'pad') {
      $('start').innerHTML = this.fmt('startPad');
      $('t-controls').innerHTML = this.fmt('controlsPad');
      $('p-resume').innerHTML = this.fmt('resumePad');
    } else if (this.isTouch) {
      $('start').textContent = t.startTouch;
      $('t-controls').innerHTML = t.controlsTouch;
      $('p-resume').textContent = t.resumeTouch;
    } else {
      $('start').textContent = t.start;
      $('t-controls').innerHTML = t.controls;
      $('p-resume').textContent = t.resume;
    }
    // 「座る」「立つ」のキー
    if (d === 'pad') {
      this.promptKey.innerHTML = this.fmt('{south}');
      this.promptKey.classList.add('glyph');
    } else {
      this.promptKey.textContent = 'E';
      this.promptKey.classList.remove('glyph');
    }
    document.body.classList.toggle('pad', d === 'pad');
    if (this.hintKind && this.hintTimer > 0) this.renderHint();
  }

  setLoading(on) {
    $('loading').classList.toggle('show', on);
  }

  showTitle(cleared) {
    $('t-welcome').hidden = !cleared;
    $('title').classList.add('show');
  }

  hideTitle() {
    $('title').classList.remove('show');
  }

  setPrompt(kind) {
    if (kind === this.promptKind) return;
    this.promptKind = kind;
    if (!kind) {
      this.prompt.classList.remove('show');
      this.act.classList.remove('show');
      return;
    }
    const label = kind === 'sit' ? this.t.sit : this.t.stand;
    this.promptLabel.textContent = label;
    this.prompt.classList.toggle('dim', kind === 'stand');
    this.prompt.classList.add('show');
    this.act.textContent = label;
    this.act.classList.add('show');
  }

  say(key, dur = 6) {
    this.caption.textContent = this.t[key] ?? key;
    this.caption.classList.add('show');
    this.capTimer = dur;
  }

  // 'move' のように種類だけ渡すと、操作の種類に合った文を選ぶ
  hint(kind, dur = 7) {
    this.hintKind = kind;
    this.hintTimer = dur;
    this.renderHint();
    this.hintEl.classList.add('show');
  }

  renderHint() {
    const k = this.hintKind;
    if (k === 'move') {
      const key = this.device === 'pad' ? 'moveHintPad' : this.device === 'touch' ? 'moveHintTouch' : 'moveHint';
      this.hintEl.innerHTML = this.fmt(key);
    } else this.hintEl.innerHTML = this.fmt(k);
  }

  update(dt) {
    if (this.capTimer > 0) {
      this.capTimer -= dt;
      if (this.capTimer <= 0) this.caption.classList.remove('show');
    }
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.hintEl.classList.remove('show');
    }
  }

  showPause(on) {
    $('pause').classList.toggle('show', on);
  }

  showEnding(on) {
    $('ending').classList.toggle('show', on);
  }

  showEndingButtons(on) {
    $('ending').classList.toggle('buttons', on);
  }

  showTouch(on) {
    if (this.isTouch) $('touch').hidden = !on;
  }

  setHud(on) {
    $('hud').classList.toggle('hide', !on);
  }

  showAudioNotice(on) {
    $('audio-notice').classList.toggle('show', on);
  }
}

export { STR };
