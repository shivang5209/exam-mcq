/**
 * QuizForge Core Application Logic
 * Pure ES6 JS managing Storage, MCQ Parser, Quiz Engine & UI Router
 */

// Global State
const state = {
  data: {
    projects: [],
    history: []
  },
  activeProjectId: null,
  activeChapterId: null,
  
  // Firebase & Rooms State
  firebaseUser: null,
  activeRoomId: null,
  participantName: '',
  isParticipantMode: false,
  leaderboardUnsubscribe: null,
  guestMode: false,

  // Quiz Session State
  quiz: {
    questions: [],        // Questions selected for the active quiz
    shuffledQuestions: [],// Array of questions in shuffled order
    currentIndex: 0,      // Current question index
    answers: {},          // Map of index -> user selected option index (0-based)
    settings: {
      timer: 30,          // Seconds per question (0 = disabled)
      shuffle: true,      // Shuffle questions
      mode: 'quiz'        // 'quiz' (immediate feedback) or 'exam' (feedback at end)
    },
    timerId: null,
    timeLeft: 30,
    startTime: null,
    endTime: null,
    retakingWrongOnly: false
  }
};

// ==========================================
// STORAGE CONTROLLER
// ==========================================
const Storage = {
  KEY: 'quizforge_data',

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) {
        state.data = JSON.parse(raw);
        // Ensure structure is sound
        if (!state.data.projects) state.data.projects = [];
        if (!state.data.history) state.data.history = [];
      } else {
        this.save();
      }
    } catch (e) {
      console.error("Failed to load data from localStorage", e);
      showToast("Error loading saved data", "danger");
    }
  },

  save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(state.data));
    } catch (e) {
      console.error("Failed to save data to localStorage", e);
      showToast("Storage full or unavailable!", "danger");
    }
  }
};

// ==========================================
// HELPER UTILITIES
// ==========================================
function generateUUID() {
  return 'uuid-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now().toString(36);
}

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${message}</span>
    <button class="toast-close">&times;</button>
  `;
  container.appendChild(toast);

  // Auto remove
  const timeout = setTimeout(() => {
    toast.remove();
  }, 4000);

  toast.querySelector('.toast-close').addEventListener('click', () => {
    clearTimeout(timeout);
    toast.remove();
  });
}

// Format time from seconds to MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ==========================================
// SMART NORMALIZER — Auto-corrects messy text
// ==========================================
const SmartNormalizer = {

  /**
   * Main entry point. Runs text through all correction passes.
   * Returns { normalizedText, fixes[] } where fixes is a list of
   * human-readable descriptions of corrections made.
   */
  normalize(rawText) {
    const fixes = [];
    let text = rawText;

    text = this.fixLineEndings(text, fixes);
    text = this.stripMarkdownDecorations(text, fixes);
    text = this.normalizeAnswerLines(text, fixes);
    text = this.markInlineCorrect(text, fixes);
    text = this.fixInlineOptions(text, fixes);
    text = this.fixMissingSpaceAfterOptionLetter(text, fixes);
    text = this.normalizeNumericOptions(text, fixes);
    text = this.normalizeBullets(text, fixes);
    text = this.collapseBlankLines(text, fixes);

    return { normalizedText: text, fixes };
  },

  // Pass 1: Normalize line endings (Windows \r\n → \n)
  fixLineEndings(text, fixes) {
    if (text.includes('\r')) {
      fixes.push('Normalized Windows line endings (CRLF → LF)');
      return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    return text;
  },

  // Pass 2: Strip markdown decorations (## headers, **bold**, ---)
  stripMarkdownDecorations(text, fixes) {
    let changed = false;
    const lines = text.split('\n').map(line => {
      // Strip leading ##, >, --- section dividers (but keep option lines like A) alone)
      const stripped = line
        .replace(/^#{1,6}\s+/, '')        // ## Heading
        .replace(/^>\s*/, '')             // > blockquote
        .replace(/^-{3,}\s*$/, '')        // --- divider
        .replace(/^={3,}\s*$/, '')        // === divider
        .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
        .replace(/\*([^*]+)\*/g, '$1')    // *italic*
        .replace(/__([^_]+)__/g, '$1')    // __underline__
        .replace(/_([^_]+)_/g, '$1')      // _italic_
        .replace(/`([^`]+)`/g, '$1');     // `code`
      if (stripped !== line) changed = true;
      return stripped;
    });
    if (changed) fixes.push('Removed markdown formatting (bold, italic, headers, dividers)');
    return lines.join('\n');
  },

  // Pass 3: Normalize all answer line variants to "ANS: X"
  normalizeAnswerLines(text, fixes) {
    // Matches: Answer: B | Correct Answer: b | Correct: B | Ans- B | Answer = B | answer:b
    const answerPattern = /^[ \t]*(?:correct\s*answer|correct|answer|ans(?:wer)?)\s*[-:=.]\s*([a-d1-4])/img;
    let changed = false;
    const result = text.replace(answerPattern, (match, letter) => {
      changed = true;
      // Convert number answers (1=A, 2=B...) to letters
      const num = parseInt(letter);
      const normalized = isNaN(num) ? letter.toUpperCase() : String.fromCharCode(64 + num);
      return `ANS: ${normalized}`;
    });
    if (changed) fixes.push('Normalized answer lines to standard "ANS: X" format');
    return result;
  },

  // Pass 4: Detect inline correct markers like (correct), ✓, *, [correct]
  markInlineCorrect(text, fixes) {
    // Pattern: an option line followed by a correct marker
    // e.g.  B) Some answer (correct)  OR  B) Some answer ✓
    const inlineCorrectPattern = /^([ \t]*[a-d][)\.][ \t]*.+?)[ \t]*(?:\(correct\)|✓|\[correct\]|\*correct\*)[ \t]*$/im;
    if (inlineCorrectPattern.test(text)) {
      let correctLetter = null;
      const lines = text.split('\n');
      const cleanedLines = lines.map(line => {
        const m = line.match(/^[ \t]*([a-d])[)\.][ \t]*.+?[ \t]*(?:\(correct\)|✓|\[correct\]|\*correct\*)[ \t]*$/i);
        if (m) {
          correctLetter = m[1].toUpperCase();
          // Remove the marker
          return line.replace(/[ \t]*(?:\(correct\)|✓|\[correct\]|\*correct\*)[ \t]*$/i, '').trimEnd();
        }
        return line;
      });
      // Append ANS line after the last option of this question block
      // We'll insert it right after the last option group
      if (correctLetter) {
        fixes.push(`Detected inline correct marker → converted to "ANS: ${correctLetter}"`);
        // Find where to insert the ANS line: after the last option line in the question block
        let lastOptionIdx = -1;
        for (let i = cleanedLines.length - 1; i >= 0; i--) {
          if (/^[ \t]*[a-d][)\.][ \t]*/i.test(cleanedLines[i])) {
            lastOptionIdx = i;
            break;
          }
        }
        if (lastOptionIdx !== -1) {
          cleanedLines.splice(lastOptionIdx + 1, 0, `ANS: ${correctLetter}`);
        }
        return cleanedLines.join('\n');
      }
    }
    return text;
  },

  // Pass 5: Split options that are on the same line
  // e.g. "A) Yes B) No C) Maybe D) Never"  →  4 separate lines
  fixInlineOptions(text, fixes) {
    let changed = false;
    const lines = text.split('\n');
    const result = [];

    for (const line of lines) {
      // Detect a line that has 2+ option patterns (like A) ... B) ... C) ...)
      // We match: start with optional option letter, then contain other option letters
      const splitPattern = /\s+(?=[A-D][)\.]\s)/gi;
      // Quick test: does this line contain at least two option markers?
      const optionMarkerCount = (line.match(/\b[A-D][)\.]\s/gi) || []).length;
      if (optionMarkerCount >= 2) {
        // Split by option markers, preserving the letter
        const parts = line.split(/(?=\b[A-D][)\.]\s)/i);
        if (parts.length >= 2) {
          changed = true;
          for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed) result.push(trimmed);
          }
          continue;
        }
      }
      result.push(line);
    }

    if (changed) fixes.push('Split options that were written on the same line');
    return result.join('\n');
  },

  // Pass 6: Fix missing space after option letter: "A)Text" → "A) Text"
  fixMissingSpaceAfterOptionLetter(text, fixes) {
    const pattern = /^([ \t]*)([A-Da-d])([)\.])(\S)/gm;
    if (pattern.test(text)) {
      fixes.push('Added missing space after option letters (e.g. "A)Text" → "A) Text")');
      return text.replace(/^([ \t]*)([A-Da-d])([)\.])(\S)/gm, '$1$2$3 $4');
    }
    return text;
  },

  // Pass 7: Normalize numeric option labels to letter labels
  // e.g.  1. Option  2. Option  → A) Option  B) Option
  // Only applies when inside a question block (between question line and ANS: line)
  normalizeNumericOptions(text, fixes) {
    const lines = text.split('\n');
    let inQuestionBlock = false;
    let changed = false;
    let optionCount = 0;

    // Detect if numeric options are used: lines like "1. text" or "(1) text" after a question line
    // We check if ≥2 consecutive lines match numeric option pattern after a question-like line
    const isQuestionLine = (l) => /^\d+[\.)\s]/.test(l.trim()) || /^(?:Q|Question)\s*\d*[:\.-]/i.test(l.trim());
    const isNumericOption = (l) => /^[ \t]*[1-4][\.)\-]\s+\S/.test(l);
    const isAnswerLine = (l) => /^ANS:/i.test(l.trim());
    const isExistingLetterOption = (l) => /^[ \t]*[A-Da-d][)\.]\s/i.test(l);

    // Count numeric option lines in file — if many exist, normalize them
    const numericOptLines = lines.filter(isNumericOption).length;
    const letterOptLines = lines.filter(isExistingLetterOption).length;

    if (numericOptLines > letterOptLines && numericOptLines >= 4) {
      // Likely the whole file uses numeric options — convert them
      const letterMap = { '1': 'A', '2': 'B', '3': 'C', '4': 'D' };
      const converted = lines.map(line => {
        const m = line.match(/^([ \t]*)([1-4])([\.)\-])\s+(.+)$/);
        if (m) {
          const letter = letterMap[m[2]];
          if (letter) {
            changed = true;
            return `${m[1]}${letter}) ${m[4]}`;
          }
        }
        return line;
      });
      if (changed) {
        fixes.push('Converted numeric option labels (1. 2. 3. 4.) to letter labels (A) B) C) D))');
        return converted.join('\n');
      }
    }
    return text;
  },

  // Pass 8: Normalize Unicode bullets and dashes to clean lines
  normalizeBullets(text, fixes) {
    const bulletPattern = /^[ \t]*[•●▸▹►◦‣⁃–—][ \t]*/gm;
    if (bulletPattern.test(text)) {
      fixes.push('Removed Unicode bullet symbols (•, –, —, etc.)');
      return text.replace(/^[ \t]*[•●▸▹►◦‣⁃–—][ \t]*/gm, '');
    }
    return text;
  },

  // Pass 9: Collapse excessive blank lines (3+ in a row → 1)
  collapseBlankLines(text, fixes) {
    if (/\n{3,}/.test(text)) {
      fixes.push('Collapsed excessive blank lines');
      return text.replace(/\n{3,}/g, '\n\n');
    }
    return text;
  }
};


// ==========================================
// MCQ TEXT PARSER ENGINE
// ==========================================
const MCQParser = {

  /**
   * Full pipeline: normalize → parse.
   * Returns { questions, fixes, normalizedText }
   */
  parseWithReport(rawText) {
    const { normalizedText, fixes } = SmartNormalizer.normalize(rawText);
    const questions = this.parse(normalizedText);
    return { questions, fixes, normalizedText };
  },

  preprocessLine(line) {
    // Matches inline options like: A) text B) text C) text
    // We split by option letters A-F with delimiters ) or .
    // We support optional opening parenthesis like (A) or standard A)
    const parts = line.split(/\s+\(?([A-F])[\)\.]\s+/i);
    if (parts.length > 3) {
      const newLines = [];
      if (parts[0].trim()) {
        newLines.push(parts[0].trim());
      }
      for (let k = 1; k < parts.length; k += 2) {
        const optLetter = parts[k];
        const optText = parts[k + 1] ? parts[k + 1].trim() : '';
        newLines.push(`${optLetter.toUpperCase()}) ${optText}`);
      }
      return newLines;
    }
    return [line];
  },

  /**
   * Core parser: takes normalized text and returns question objects.
   * Supports all standard formats after normalization:
   * - Q: / Question: / 1. / 1) prefixed questions
   * - A) / a) / (a) / [a] option lines
   * - ANS: X answer lines
   */
  parse(text) {
    if (!text || !text.trim()) return [];

    const rawLines = text.split('\n');
    const lines = [];
    for (let i = 0; i < rawLines.length; i++) {
      const processed = this.preprocessLine(rawLines[i]);
      lines.push(...processed);
    }

    const questions = [];
    let currentQuestion = null;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      // Clean remaining markdown decorations
      line = line.replace(/^[#\*\-\s\_\>]+(?![a-dA-D][)\.])/,'').trimStart();
      line = line.replace(/[\*\_]+$/, '').trimEnd();
      if (!line) continue;

      // Skip explanation/commentary lines
      if (/^(?:Explanation|Concept|Note|Hint|Topic|Section|Chapter|Unit|Part)\s*[:\.-=\s]/i.test(line)) continue;

      // Skip pure separator lines
      if (/^[-=_]{3,}$/.test(line)) continue;

      // 1. Answer line
      const ansMatch = line.match(/^(?:ANS|ANSWER|Correct\s*Answer|Correct)\s*[:\.-=\s]\s*(.*)/i);
      if (ansMatch && currentQuestion) {
        currentQuestion.rawAnswerChar = ansMatch[1].trim().toUpperCase();
        continue;
      }

      // 2. Option line — A) or a) or (a) or [a]
      const optMatch =
        line.match(/^([a-dA-D])\s*[\)\.\-]\s+(.+)/) ||
        line.match(/^\(([a-dA-D])\)\s+(.+)/) ||
        line.match(/^\[([a-dA-D])\]\s+(.+)/);

      if (optMatch && currentQuestion) {
        currentQuestion.options.push(optMatch[2].trim());
        continue;
      }

      // 3. Question line — numbered or prefixed
      const qPrefixMatch = line.match(/^(?:Q|Question|Quest|No)\.?\s*\d*[:\.-]?\s+(.+)/i);
      const qNumMatch = line.match(/^(\d{1,3})[\.)\s]\s*(.+)/);

      let isNewQuestion = false;
      let qText = '';

      if (qPrefixMatch) {
        isNewQuestion = true;
        qText = qPrefixMatch[1].trim();
      } else if (qNumMatch) {
        // Only treat as new question if the number is reasonable (not an option number)
        const num = parseInt(qNumMatch[1]);
        if (num >= 1 && num <= 999) {
          isNewQuestion = true;
          qText = qNumMatch[2].trim();
        }
      } else if (currentQuestion && currentQuestion.options.length > 0) {
        // After options, any non-option/non-answer line = new question
        isNewQuestion = true;
        qText = line;
      }

      if (isNewQuestion) {
        if (currentQuestion && this.validateQuestion(currentQuestion)) {
          questions.push(currentQuestion);
        }
        currentQuestion = {
          id: generateUUID(),
          text: qText,
          options: [],
          answer: -1,
          rawAnswerChar: ''
        };
        continue;
      }

      // 4. Default: append to current question text (multi-line questions)
      if (currentQuestion) {
        if (currentQuestion.options.length === 0) {
          currentQuestion.text += ' ' + line;
        }
        // Lines after options but before ANS are ignored (e.g. stray text)
      } else {
        // Start a new implied question from this line
        currentQuestion = {
          id: generateUUID(),
          text: line,
          options: [],
          answer: -1,
          rawAnswerChar: ''
        };
      }
    }

    // Flush last question
    if (currentQuestion && this.validateQuestion(currentQuestion)) {
      questions.push(currentQuestion);
    }

    // Resolve letter answers to zero-based indices
    questions.forEach(q => {
      if (q.rawAnswerChar) {
        const ans = q.rawAnswerChar.trim();
        const charCode = ans.charCodeAt(0);
        if (ans.length === 1 && charCode >= 65 && charCode <= 90) {
          q.answer = charCode - 65; // A=0, B=1, C=2...
        } else {
          const numIdx = parseInt(ans) - 1;
          if (!isNaN(numIdx) && numIdx >= 0 && numIdx < q.options.length) {
            q.answer = numIdx;
          } else {
            const matchIdx = q.options.findIndex(o => o.toLowerCase() === ans.toLowerCase());
            if (matchIdx !== -1) q.answer = matchIdx;
          }
        }
      }
      delete q.rawAnswerChar;
    });

    return questions.filter(q => q.answer >= 0 && q.answer < q.options.length);
  },

  validateQuestion(q) {
    return q.text && q.text.length > 3 && q.options.length >= 2;
  }
};

// ==========================================
// CORE APP APP ENGINE
// ==========================================
const app = {
  init() {
    Storage.load();
    this.bindEvents();
    this.initFirebase();

    // Check if loading a shared quiz room
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');
    if (roomId) {
      this.joinRoom(roomId);
    } else {
      // If Firebase is NOT initialized, go directly to local dashboard
      if (!window.FirebaseConfig || !window.FirebaseConfig.isInitialized()) {
        this.renderDashboard();
        this.showView('view-dashboard');
        this.updateStats();
      } else {
        // Show landing page while waiting for auth status
        this.showView('view-landing');
      }
    }
  },

  // Navigation / View Router
  showView(viewId) {
    document.querySelectorAll('.app-view').forEach(view => {
      view.classList.remove('active');
    });
    const targetView = document.getElementById(viewId);
    if (targetView) {
      targetView.classList.add('active');
    }
    window.scrollTo(0, 0);
  },

  initFirebase() {
    if (!window.FirebaseConfig || !window.FirebaseConfig.isInitialized()) {
      document.getElementById('btn-login-trigger').style.display = 'none';
      return;
    }

    const authObj = window.FirebaseConfig.getAuth();

    // Show Sign In button
    document.getElementById('btn-login-trigger').style.display = 'inline-flex';
    // Show Share Room button in chapters
    document.getElementById('btn-share-room').style.display = 'inline-flex';

    // Listen for Auth changes
    authObj.onAuthStateChanged(user => {
      if (user) {
        state.firebaseUser = user;
        document.getElementById('btn-login-trigger').style.display = 'none';
        document.getElementById('user-profile-menu').style.display = 'flex';
        document.getElementById('user-email-display').textContent = user.email;
        showToast(`Signed in as ${user.email}`);

        // Redirect to dashboard if currently on landing view
        const currentActiveView = document.querySelector('.app-view.active');
        if (!currentActiveView || currentActiveView.id === 'view-landing') {
          this.renderDashboard();
          this.showView('view-dashboard');
          this.updateStats();
        }
      } else {
        state.firebaseUser = null;
        document.getElementById('btn-login-trigger').style.display = 'inline-flex';
        document.getElementById('user-profile-menu').style.display = 'none';

        // Redirect to landing page unless we are in participant mode or guest mode
        if (!state.isParticipantMode && !state.guestMode) {
          this.showView('view-landing');
        }
      }
      
      // Sync chapter state if open
      if (state.activeProjectId && state.activeChapterId) {
        this.syncChapterRoomState();
      }
    });
  },

  async joinRoom(roomId) {
    this.showView('view-join-room');
    document.getElementById('join-room-title').textContent = "Loading Room...";
    document.getElementById('join-room-desc').textContent = "Fetching quiz details from server...";
    document.getElementById('join-room-meta').style.display = 'none';
    document.getElementById('join-room-setup').style.display = 'none';

    if (!window.FirebaseConfig || !window.FirebaseConfig.isInitialized()) {
      document.getElementById('join-room-title').textContent = "Connection Error";
      document.getElementById('join-room-desc').textContent = "Firebase is not configured on this host. Please check configuration.";
      return;
    }

    try {
      const dbObj = window.FirebaseConfig.getDb();
      const doc = await dbObj.collection('rooms').doc(roomId).get();
      if (!doc.exists) {
        document.getElementById('join-room-title').textContent = "Room Not Found";
        document.getElementById('join-room-desc').textContent = "This room doesn't exist or has been closed by the host.";
        return;
      }

      const roomData = doc.data();
      state.activeRoomId = roomId;
      state.isParticipantMode = true;
      
      // Setup Room Details
      document.getElementById('join-room-title').textContent = roomData.title;
      document.getElementById('join-room-desc').textContent = roomData.description || "Take this shared MCQ quiz and submit your results!";
      document.getElementById('join-room-q-count').textContent = roomData.questions.length;
      document.getElementById('join-room-owner').textContent = roomData.ownerEmail.split('@')[0];
      
      document.getElementById('join-room-meta').style.display = 'flex';
      document.getElementById('join-room-setup').style.display = 'block';

      // Setup the quiz questions directly in session state
      state.quiz.questions = roomData.questions;

    } catch (error) {
      console.error("Error joining room:", error);
      document.getElementById('join-room-title').textContent = "Load Failed";
      document.getElementById('join-room-desc').textContent = "Failed to communicate with database: " + error.message;
    }
  },

  joinRoomQuiz() {
    const name = document.getElementById('participant-name-input').value.trim();
    if (!name) {
      showToast("Please enter a nickname", "danger");
      return;
    }

    state.participantName = name;
    
    // Default participant settings: 30s timer, shuffled questions, quiz mode
    state.quiz.settings.timer = 30;
    state.quiz.settings.shuffle = true;
    state.quiz.settings.mode = 'quiz';
    
    this.initializeQuizSequence();
  },

  leaveRoom() {
    state.isParticipantMode = false;
    state.activeRoomId = null;
    state.participantName = '';
    // Reset search params in URL
    window.history.pushState({}, document.title, window.location.pathname);
    this.renderDashboard();
    this.showView('view-dashboard');
  },

  // ==========================================
  // EVENT BINDINGS
  // ==========================================
  bindEvents() {
    // Logo / Brand home navigation
    document.getElementById('logo-btn').addEventListener('click', () => {
      if (state.firebaseUser || state.guestMode || !window.FirebaseConfig || !window.FirebaseConfig.isInitialized()) {
        this.showView('view-dashboard');
        this.renderDashboard();
      } else {
        this.showView('view-landing');
      }
    });

    // Create Project Trigger
    document.getElementById('create-project-btn').addEventListener('click', () => {
      this.showCreateProjectModal();
    });
    
    document.getElementById('btn-save-project').addEventListener('click', () => {
      this.handleCreateProject();
    });

    // Create Chapter Trigger
    document.getElementById('create-chapter-btn').addEventListener('click', () => {
      this.showCreateChapterModal();
    });
    document.getElementById('project-empty-create-chapter').addEventListener('click', () => {
      this.showCreateChapterModal();
    });
    document.getElementById('btn-save-chapter').addEventListener('click', () => {
      this.handleCreateChapter();
    });

    // Breadcrumbs Navigation
    document.getElementById('project-nav-back').addEventListener('click', () => {
      this.showView('view-dashboard');
      this.renderDashboard();
    });

    document.getElementById('chapter-nav-project').addEventListener('click', () => {
      if (state.activeProjectId) {
        this.openProject(state.activeProjectId);
      }
    });

    // Rename & Delete Project/Chapter Actions
    document.getElementById('rename-project-btn').addEventListener('click', () => {
      this.showRenameModal('project');
    });
    document.getElementById('delete-project-btn').addEventListener('click', () => {
      this.handleDeleteProject();
    });
    document.getElementById('rename-chapter-btn').addEventListener('click', () => {
      this.showRenameModal('chapter');
    });
    document.getElementById('delete-chapter-btn').addEventListener('click', () => {
      this.handleDeleteChapter();
    });
    document.getElementById('btn-save-rename').addEventListener('click', () => {
      this.handleSaveRename();
    });

    // Tab buttons in Chapter Detail
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tabContainer = btn.closest('.card-body');
        tabContainer.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
        tabContainer.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        btn.classList.add('active');
        const targetTab = btn.getAttribute('data-tab');
        document.getElementById(targetTab).classList.add('active');
      });
    });

    // Bulk parse & import
    document.getElementById('btn-parse-paste').addEventListener('click', () => {
      this.handlePasteParse();
    });

    // File input triggers
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    
    document.getElementById('btn-browse-file').addEventListener('click', () => {
      fileInput.click();
    });
    
    fileInput.addEventListener('change', (e) => {
      this.handleFileSelected(e.target.files[0]);
    });

    // Drag-and-drop
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        this.handleFileSelected(e.dataTransfer.files[0]);
      }
    });

    // Clear questions
    document.getElementById('btn-clear-questions').addEventListener('click', () => {
      this.handleClearQuestions();
    });

    // Quiz Launch / Config Screen
    document.getElementById('btn-start-quiz').addEventListener('click', () => {
      this.openQuizSetup();
    });

    document.getElementById('btn-launch-quiz-session').addEventListener('click', () => {
      this.startQuizSession();
    });

    document.getElementById('btn-quit-quiz').addEventListener('click', () => {
      if (confirm('Are you sure you want to quit the quiz? Your progress will be lost.')) {
        this.stopQuizTimer();
        this.openChapter(state.activeProjectId, state.activeChapterId);
      }
    });

    // Quiz Navigation Buttons
    document.getElementById('btn-next-question').addEventListener('click', () => {
      this.nextQuestion();
    });

    document.getElementById('btn-submit-exam-answer').addEventListener('click', () => {
      this.nextQuestion();
    });

    // Results Actions
    document.getElementById('btn-restart-quiz').addEventListener('click', () => {
      this.openQuizSetup();
    });

    document.getElementById('btn-retake-wrong').addEventListener('click', () => {
      this.startRetakeWrongOnly();
    });

    document.getElementById('btn-results-back').addEventListener('click', () => {
      if (state.isParticipantMode) {
        this.showView('view-join-room');
      } else {
        this.openChapter(state.activeProjectId, state.activeChapterId);
      }
    });

    // Import/Export Modal Trigger
    document.getElementById('import-export-btn').addEventListener('click', () => {
      this.showImportExportModal();
    });
    
    document.getElementById('btn-export-backup').addEventListener('click', () => {
      this.handleExportBackup();
    });

    document.getElementById('backup-file-input').addEventListener('change', (e) => {
      this.handleImportBackup(e.target.files[0]);
    });

    document.getElementById('btn-clear-history').addEventListener('click', () => {
      this.handleClearHistory();
    });

    // Auth Tab switches
    const tabSignin = document.getElementById('auth-tab-signin');
    const tabSignup = document.getElementById('auth-tab-signup');
    const formSignin = document.getElementById('auth-form-signin');
    const formSignup = document.getElementById('auth-form-signup');

    tabSignin.addEventListener('click', () => {
      tabSignin.classList.add('active');
      tabSignup.classList.remove('active');
      formSignin.classList.add('active');
      formSignup.classList.remove('active');
    });

    tabSignup.addEventListener('click', () => {
      tabSignup.classList.add('active');
      tabSignin.classList.remove('active');
      formSignup.classList.add('active');
      formSignin.classList.remove('active');
    });

    // Login Modal Triggers
    document.getElementById('btn-login-trigger').addEventListener('click', () => {
      document.getElementById('login-email').value = '';
      document.getElementById('login-password').value = '';
      document.getElementById('register-email').value = '';
      document.getElementById('register-password').value = '';
      this.openModal('modal-auth');
    });

    // Auth Submission Handlers
    document.getElementById('btn-auth-signin').addEventListener('click', () => {
      const email = document.getElementById('login-email').value.trim();
      const pass = document.getElementById('login-password').value;
      if (!email || !pass) {
        showToast("Please enter email and password", "danger");
        return;
      }
      window.FirebaseConfig.getAuth().signInWithEmailAndPassword(email, pass)
        .then(() => this.closeModals())
        .catch(err => showToast(err.message, "danger"));
    });

    document.getElementById('btn-auth-signup').addEventListener('click', () => {
      const email = document.getElementById('register-email').value.trim();
      const pass = document.getElementById('register-password').value;
      if (!email || pass.length < 6) {
        showToast("Email required, password must be at least 6 characters", "danger");
        return;
      }
      window.FirebaseConfig.getAuth().createUserWithEmailAndPassword(email, pass)
        .then(() => this.closeModals())
        .catch(err => showToast(err.message, "danger"));
    });

    document.getElementById('btn-auth-google').addEventListener('click', () => {
      const provider = new firebase.auth.GoogleAuthProvider();
      window.FirebaseConfig.getAuth().signInWithPopup(provider)
        .then(() => this.closeModals())
        .catch(err => showToast(err.message, "danger"));
    });

    document.getElementById('btn-logout').addEventListener('click', () => {
      window.FirebaseConfig.getAuth().signOut()
        .then(() => {
          showToast("Logged out successfully");
          this.closeModals();
          this.showView('view-dashboard');
          this.renderDashboard();
        })
        .catch(err => showToast(err.message, "danger"));
    });

    // Share & Close Room Triggers
    document.getElementById('btn-share-room').addEventListener('click', () => {
      this.publishRoom();
    });

    document.getElementById('btn-close-room').addEventListener('click', () => {
      this.closeRoom();
    });

    document.getElementById('btn-copy-share-url').addEventListener('click', () => {
      const copyText = document.getElementById('share-room-url');
      copyText.select();
      copyText.setSelectionRange(0, 99999);
      navigator.clipboard.writeText(copyText.value);
      showToast("Share link copied to clipboard!");
    });

    // Participant Room Actions
    document.getElementById('btn-enter-room').addEventListener('click', () => {
      this.joinRoomQuiz();
    });

    document.getElementById('btn-leave-room').addEventListener('click', () => {
      this.leaveRoom();
    });

    // Landing View Actions
    document.getElementById('btn-landing-google').addEventListener('click', () => {
      const provider = new firebase.auth.GoogleAuthProvider();
      window.FirebaseConfig.getAuth().signInWithPopup(provider)
        .then(() => this.closeModals())
        .catch(err => showToast(err.message, "danger"));
    });

    document.getElementById('btn-landing-email-login').addEventListener('click', () => {
      document.getElementById('login-email').value = '';
      document.getElementById('login-password').value = '';
      this.openModal('modal-auth');
    });

    document.getElementById('btn-landing-guest').addEventListener('click', () => {
      state.guestMode = true;
      this.renderDashboard();
      this.showView('view-dashboard');
      this.updateStats();
      showToast("Entered offline guest mode!");
    });
  },

  // ==========================================
  // DASHBOARD RENDER & ACTIONS
  // ==========================================
  renderDashboard() {
    const grid = document.getElementById('projects-grid');
    const emptyState = document.getElementById('dashboard-empty-state');
    
    // Clear old elements, save empty state references
    grid.innerHTML = '';
    grid.appendChild(emptyState);

    if (state.data.projects.length === 0) {
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';

    state.data.projects.forEach(project => {
      const card = document.createElement('div');
      card.className = 'project-card';
      card.setAttribute('data-id', project.id);
      
      const totalQuestions = project.chapters.reduce((sum, ch) => sum + ch.questions.length, 0);

      card.innerHTML = `
        <div class="project-card-info">
          <div class="project-card-title">${this.escapeHTML(project.name)}</div>
          <div class="project-card-desc">${this.escapeHTML(project.description || 'No description')}</div>
        </div>
        <div class="project-card-footer">
          <div class="project-card-stats">
            <div class="project-card-stat">
              <span>📖</span> ${project.chapters.length} Chapters
            </div>
            <div class="project-card-stat">
              <span>❓</span> ${totalQuestions} Questions
            </div>
          </div>
          <div class="card-action-hover-btn">→</div>
        </div>
      `;

      card.addEventListener('click', () => {
        this.openProject(project.id);
      });

      grid.appendChild(card);
    });
    this.renderHistory();
  },

  updateStats() {
    const projectsCount = state.data.projects.length;
    const chaptersCount = state.data.projects.reduce((sum, p) => sum + p.chapters.length, 0);
    const questionsCount = state.data.projects.reduce((sum, p) => {
      return sum + p.chapters.reduce((chSum, ch) => chSum + ch.questions.length, 0);
    }, 0);

    document.getElementById('stat-projects-count').textContent = projectsCount;
    document.getElementById('stat-chapters-count').textContent = chaptersCount;
    document.getElementById('stat-questions-count').textContent = questionsCount;
  },

  renderHistory() {
    const tbody = document.getElementById('history-table-body');
    const table = document.getElementById('history-table');
    const emptyState = document.getElementById('history-empty-state');
    const clearBtn = document.getElementById('btn-clear-history');

    tbody.innerHTML = '';

    if (!state.data.history || state.data.history.length === 0) {
      table.style.display = 'none';
      emptyState.style.display = 'block';
      clearBtn.style.display = 'none';
      return;
    }

    table.style.display = 'table';
    emptyState.style.display = 'none';
    clearBtn.style.display = 'inline-flex';

    // Show last 10 attempts
    const recentHistory = state.data.history.slice(0, 10);

    recentHistory.forEach(entry => {
      const row = document.createElement('tr');
      const date = new Date(entry.timestamp);
      const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

      let badgeClass = 'badge-score-low';
      if (entry.percentage >= 80) {
        badgeClass = 'badge-score-high';
      } else if (entry.percentage >= 50) {
        badgeClass = 'badge-score-mid';
      }

      row.innerHTML = `
        <td>${formattedDate}</td>
        <td><strong>${this.escapeHTML(entry.projectName)}</strong> / ${this.escapeHTML(entry.chapterName)}</td>
        <td>${entry.correct} / ${entry.total}</td>
        <td><span class="badge-score ${badgeClass}">${entry.percentage}%</span></td>
        <td>${formatTime(entry.timeSpent)}</td>
        <td><span style="text-transform: capitalize; font-size: 0.85rem; opacity: 0.8;">${entry.mode || 'quiz'}</span></td>
      `;
      tbody.appendChild(row);
    });
  },

  handleClearHistory() {
    if (confirm('Are you sure you want to clear your test history? This cannot be undone.')) {
      state.data.history = [];
      Storage.save();
      this.renderHistory();
      showToast('Test history cleared');
    }
  },

  // ==========================================
  // PROJECT ACTIONS
  // ==========================================
  showCreateProjectModal() {
    document.getElementById('project-name-input').value = '';
    document.getElementById('project-desc-input').value = '';
    this.openModal('modal-create-project');
  },

  handleCreateProject() {
    const name = document.getElementById('project-name-input').value.trim();
    const desc = document.getElementById('project-desc-input').value.trim();

    if (!name) {
      showToast('Please enter a project name', 'danger');
      return;
    }

    const newProject = {
      id: generateUUID(),
      name,
      description: desc,
      createdAt: new Date().toISOString(),
      chapters: []
    };

    state.data.projects.push(newProject);
    Storage.save();
    this.closeModals();
    this.renderDashboard();
    this.updateStats();
    showToast('Project created successfully!');
  },

  openProject(projectId) {
    const project = state.data.projects.find(p => p.id === projectId);
    if (!project) return;

    state.activeProjectId = projectId;
    state.activeChapterId = null;

    document.getElementById('project-detail-title').textContent = project.name;
    document.getElementById('project-detail-desc').textContent = project.description || 'Study chapters and question collection';

    this.renderChapters(project);
    this.showView('view-project');
  },

  renderChapters(project) {
    const list = document.getElementById('chapters-list');
    const emptyState = document.getElementById('project-empty-state');
    list.innerHTML = '';

    if (project.chapters.length === 0) {
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';

    project.chapters.forEach(chapter => {
      const item = document.createElement('div');
      item.className = 'chapter-item';
      item.innerHTML = `
        <div class="chapter-item-meta">
          <span class="chapter-item-icon">📘</span>
          <span class="chapter-item-name">${this.escapeHTML(chapter.name)}</span>
        </div>
        <div class="chapter-item-actions">
          <span class="chapter-q-badge">${chapter.questions.length} MCQs</span>
          <span class="chapter-item-icon">→</span>
        </div>
      `;

      item.addEventListener('click', () => {
        this.openChapter(project.id, chapter.id);
      });

      list.appendChild(item);
    });
  },

  // ==========================================
  // CHAPTER ACTIONS
  // ==========================================
  showCreateChapterModal() {
    document.getElementById('chapter-name-input').value = '';
    this.openModal('modal-create-chapter');
  },

  handleCreateChapter() {
    const name = document.getElementById('chapter-name-input').value.trim();

    if (!name) {
      showToast('Please enter a chapter title', 'danger');
      return;
    }

    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    if (!project) return;

    const newChapter = {
      id: generateUUID(),
      name,
      questions: []
    };

    project.chapters.push(newChapter);
    Storage.save();
    this.closeModals();
    this.renderChapters(project);
    this.updateStats();
    showToast('Chapter added successfully!');
  },

  openChapter(projectId, chapterId) {
    const project = state.data.projects.find(p => p.id === projectId);
    if (!project) return;
    const chapter = project.chapters.find(c => c.id === chapterId);
    if (!chapter) return;

    state.activeProjectId = projectId;
    state.activeChapterId = chapterId;

    // Update Nav Breadcrumbs
    document.getElementById('chapter-nav-project').textContent = project.name;
    document.getElementById('chapter-nav-current').textContent = chapter.name;

    // Update Headings
    document.getElementById('chapter-detail-title').textContent = chapter.name;
    this.updateChapterQuestionCount(chapter.questions.length);

    // Reset inputs
    document.getElementById('raw-mcq-input').value = '';
    document.getElementById('file-input').value = '';
    document.getElementById('upload-status').innerHTML = '';

    // Render questions list
    this.renderQuestionsList(chapter.questions);

    // Sync Shared Room & Leaderboards
    this.syncChapterRoomState();

    this.showView('view-chapter');
  },

  async publishRoom() {
    if (!state.firebaseUser) {
      this.openModal('modal-auth');
      showToast("Please sign in first to share a room!", "warning");
      return;
    }

    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    if (!chapter || chapter.questions.length === 0) {
      showToast("No questions to share!", "danger");
      return;
    }

    const dbObj = window.FirebaseConfig.getDb();
    
    // Check if this chapter was already published
    let roomId = chapter.roomId;
    if (!roomId) {
      roomId = generateRoomId();
      chapter.roomId = roomId;
      Storage.save();
    }

    const roomData = {
      roomId: roomId,
      ownerId: state.firebaseUser.uid,
      ownerEmail: state.firebaseUser.email,
      title: `${project.name} - ${chapter.name}`,
      description: project.description || "Take this shared MCQ quiz and submit your results!",
      questions: chapter.questions,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
      showToast("Sharing room...");
      await dbObj.collection('rooms').doc(roomId).set(roomData);
      
      const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
      document.getElementById('share-room-url').value = shareUrl;
      
      this.openModal('modal-share-room');
      this.syncChapterRoomState();

    } catch (error) {
      console.error("Error publishing room:", error);
      showToast("Failed to share room: " + error.message, "danger");
    }
  },

  async closeRoom() {
    if (!confirm("Are you sure you want to close this room? Other users will no longer be able to access it.")) return;
    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    if (!chapter || !chapter.roomId) return;

    const dbObj = window.FirebaseConfig.getDb();
    try {
      await dbObj.collection('rooms').doc(chapter.roomId).delete();
      delete chapter.roomId;
      Storage.save();
      showToast("Room closed successfully!");
      this.syncChapterRoomState();
    } catch (error) {
      showToast("Failed to close room: " + error.message, "danger");
    }
  },

  syncChapterRoomState() {
    // Unsubscribe previous listener
    if (state.leaderboardUnsubscribe) {
      state.leaderboardUnsubscribe();
      state.leaderboardUnsubscribe = null;
    }

    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    if (!project) return;
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    if (!chapter) return;

    const shareRoomBtn = document.getElementById('btn-share-room');
    const leaderboardEl = document.getElementById('chapter-leaderboard-panel');

    if (!window.FirebaseConfig || !window.FirebaseConfig.isInitialized()) {
      shareRoomBtn.style.display = 'none';
      leaderboardEl.style.display = 'none';
      return;
    }

    shareRoomBtn.style.display = 'inline-flex';

    if (chapter.roomId) {
      shareRoomBtn.textContent = '🌐 View Room Link';
      leaderboardEl.style.display = 'block';

      // Listen to submissions in Firestore
      const dbObj = window.FirebaseConfig.getDb();
      state.leaderboardUnsubscribe = dbObj.collection('rooms').doc(chapter.roomId)
        .collection('submissions')
        .orderBy('percentage', 'desc')
        .orderBy('timeSpent', 'asc')
        .onSnapshot(snapshot => {
          this.renderLeaderboard(snapshot);
        }, err => {
          console.error("Leaderboard error:", err);
        });
    } else {
      shareRoomBtn.textContent = '🌐 Share Room';
      leaderboardEl.style.display = 'none';
    }
  },

  renderLeaderboard(snapshot) {
    const tbody = document.getElementById('leaderboard-table-body');
    const emptyState = document.getElementById('leaderboard-empty-state');
    const table = document.getElementById('leaderboard-table');

    tbody.innerHTML = '';
    if (snapshot.empty) {
      table.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    table.style.display = 'table';
    emptyState.style.display = 'none';

    let rank = 1;
    snapshot.forEach(doc => {
      const data = doc.data();
      const date = data.timestamp ? new Date(data.timestamp.seconds * 1000) : new Date();
      const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

      const row = document.createElement('tr');
      
      let badgeClass = 'badge-score-low';
      if (data.percentage >= 80) badgeClass = 'badge-score-high';
      else if (data.percentage >= 50) badgeClass = 'badge-score-mid';

      row.innerHTML = `
        <td><strong>#${rank++}</strong></td>
        <td><strong>${this.escapeHTML(data.nickname)}</strong></td>
        <td>${data.correct} / ${data.total}</td>
        <td><span class="badge-score ${badgeClass}">${data.percentage}%</span></td>
        <td>${formatTime(data.timeSpent)}</td>
        <td>${formattedDate}</td>
      `;
      tbody.appendChild(row);
    });
  },

  updateChapterQuestionCount(count) {
    document.getElementById('chapter-question-count').textContent = `${count} MCQ Questions Loaded`;
    
    const startQuizBtn = document.getElementById('btn-start-quiz');
    if (count > 0) {
      startQuizBtn.removeAttribute('disabled');
      document.getElementById('btn-clear-questions').style.display = 'inline-flex';
    } else {
      startQuizBtn.setAttribute('disabled', 'true');
      document.getElementById('btn-clear-questions').style.display = 'none';
    }
  },

  renderQuestionsList(questions) {
    const listContainer = document.getElementById('questions-list');
    listContainer.innerHTML = '';

    if (questions.length === 0) {
      listContainer.innerHTML = `
        <div class="empty-state-small">
          <p>No questions imported yet. Use the parser panel on the left to add questions.</p>
        </div>
      `;
      return;
    }

    questions.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'question-item-card';
      
      // Build option descriptions
      let optionsHTML = '';
      q.options.forEach((opt, oIdx) => {
        const isCorrect = oIdx === q.answer;
        optionsHTML += `
          <div class="question-item-option ${isCorrect ? 'correct-opt' : ''}">
            ${String.fromCharCode(65 + oIdx)}) ${this.escapeHTML(opt)}
          </div>
        `;
      });

      card.innerHTML = `
        <div class="question-item-body">
          <div class="question-item-text">${idx + 1}. ${this.escapeHTML(q.text)}</div>
          <div class="question-item-options">
            ${optionsHTML}
          </div>
        </div>
        <button class="btn btn-ghost btn-sm btn-danger question-item-delete" title="Delete Question">🗑️</button>
      `;

      card.querySelector('.question-item-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleDeleteQuestion(q.id);
      });

      listContainer.appendChild(card);
    });
  },

  handleDeleteQuestion(questionId) {
    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    if (!project) return;
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    if (!chapter) return;

    chapter.questions = chapter.questions.filter(q => q.id !== questionId);
    Storage.save();
    
    this.updateChapterQuestionCount(chapter.questions.length);
    this.renderQuestionsList(chapter.questions);
    this.updateStats();
    showToast('Question deleted');
  },

  handleClearQuestions() {
    if (!confirm('Are you sure you want to clear all questions in this chapter?')) return;
    
    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    if (!project) return;
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    if (!chapter) return;

    chapter.questions = [];
    Storage.save();
    
    this.updateChapterQuestionCount(0);
    this.renderQuestionsList([]);
    this.updateStats();
    showToast('Cleared all questions');
  },

  // ==========================================
  // BULK MCQ PARSER HANDLING
  // ==========================================
  handlePasteParse() {
    const input = document.getElementById('raw-mcq-input').value;
    if (!input.trim()) {
      showToast('Input is empty', 'danger');
      return;
    }

    const { questions, fixes } = MCQParser.parseWithReport(input);
    const statusEl = document.getElementById('paste-parse-status');

    if (questions.length === 0) {
      if (statusEl) statusEl.innerHTML = this.buildParserReport(0, fixes, 'paste');
      showToast('Could not parse any valid questions. Check formatting!', 'danger');
      return;
    }

    if (statusEl) statusEl.innerHTML = this.buildParserReport(questions.length, fixes, 'paste');
    this.importQuestionsToActiveChapter(questions);
  },

  handleFileSelected(file) {
    if (!file) return;
    if (file.type !== "text/plain" && !file.name.endsWith('.txt')) {
      showToast('Please upload a plain .txt file', 'danger');
      return;
    }

    const reader = new FileReader();
    const status = document.getElementById('upload-status');
    status.innerHTML = `<span style="color:var(--text-secondary);">⏳ Reading and auto-correcting file...</span>`;

    reader.onload = (e) => {
      const content = e.target.result;
      const { questions, fixes } = MCQParser.parseWithReport(content);

      if (questions.length === 0) {
        status.innerHTML = this.buildParserReport(0, fixes, 'file');
        showToast('Could not parse any valid questions from this file', 'danger');
      } else {
        status.innerHTML = this.buildParserReport(questions.length, fixes, 'file');
        this.importQuestionsToActiveChapter(questions);
      }
    };

    reader.onerror = () => {
      status.innerHTML = `<span style="color:var(--danger);">❌ Error reading file.</span>`;
      showToast('Error reading file', 'danger');
    };

    reader.readAsText(file);
  },

  /**
   * Builds an HTML parser diagnostic report panel.
   * @param {number} count - Number of questions parsed
   * @param {string[]} fixes - List of auto-corrections applied
   * @param {string} source - 'file' or 'paste'
   */
  buildParserReport(count, fixes, source) {
    const hasFixes = fixes && fixes.length > 0;

    if (count === 0) {
      return `
        <div class="parser-report parser-report-error">
          <div class="parser-report-header">
            <span class="parser-report-icon">❌</span>
            <strong>Parse Failed</strong>
          </div>
          <p class="parser-report-msg">No valid questions could be extracted from this ${source}. Please ensure each question has at least 2 options and an answer line (ANS: X).</p>
          <details class="parser-report-details">
            <summary>View format guide</summary>
            <pre class="parser-format-example">1. Your question here?
A) Option one
B) Option two
C) Option three
D) Option four
ANS: B</pre>
          </details>
        </div>`;
    }

    const fixesHTML = hasFixes
      ? `<ul class="parser-fixes-list">${fixes.map(f => `<li>⚙️ ${f}</li>`).join('')}</ul>`
      : '';

    const statusClass = hasFixes ? 'parser-report-warn' : 'parser-report-success';
    const icon = hasFixes ? '⚠️' : '✅';
    const title = hasFixes ? `Auto-corrected &amp; Imported` : `Parsed Successfully`;
    const subtitle = hasFixes
      ? `${count} questions imported after applying ${fixes.length} auto-correction${fixes.length > 1 ? 's' : ''}`
      : `${count} questions imported cleanly — no corrections needed`;

    return `
      <div class="parser-report ${statusClass}">
        <div class="parser-report-header">
          <span class="parser-report-icon">${icon}</span>
          <div>
            <strong>${title}</strong>
            <span class="parser-report-sub">${subtitle}</span>
          </div>
        </div>
        ${fixesHTML}
      </div>`;
  },

  importQuestionsToActiveChapter(parsedQuestions) {
    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    if (!project) return;
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    if (!chapter) return;

    // Merge or append questions
    chapter.questions = [...chapter.questions, ...parsedQuestions];
    Storage.save();

    this.updateChapterQuestionCount(chapter.questions.length);
    this.renderQuestionsList(chapter.questions);
    this.updateStats();

    showToast(`Successfully imported ${parsedQuestions.length} questions!`);
  },

  // ==========================================
  // RENAME & DELETE UTILITIES
  // ==========================================
  showRenameModal(type) {
    state.renameType = type; // 'project' or 'chapter'
    const nameInput = document.getElementById('rename-input');

    if (type === 'project') {
      const project = state.data.projects.find(p => p.id === state.activeProjectId);
      if (!project) return;
      document.getElementById('rename-modal-title').textContent = 'Rename Project';
      document.getElementById('rename-input-label').textContent = 'New Project Name';
      nameInput.value = project.name;
    } else {
      const project = state.data.projects.find(p => p.id === state.activeProjectId);
      if (!project) return;
      const chapter = project.chapters.find(c => c.id === state.activeChapterId);
      if (!chapter) return;
      document.getElementById('rename-modal-title').textContent = 'Rename Chapter';
      document.getElementById('rename-input-label').textContent = 'New Chapter Title';
      nameInput.value = chapter.name;
    }

    this.openModal('modal-rename');
  },

  handleSaveRename() {
    const newName = document.getElementById('rename-input').value.trim();
    if (!newName) {
      showToast('Name cannot be empty', 'danger');
      return;
    }

    if (state.renameType === 'project') {
      const project = state.data.projects.find(p => p.id === state.activeProjectId);
      if (project) {
        project.name = newName;
        Storage.save();
        document.getElementById('project-detail-title').textContent = newName;
        showToast('Project renamed');
      }
    } else {
      const project = state.data.projects.find(p => p.id === state.activeProjectId);
      if (project) {
        const chapter = project.chapters.find(c => c.id === state.activeChapterId);
        if (chapter) {
          chapter.name = newName;
          Storage.save();
          document.getElementById('chapter-nav-current').textContent = newName;
          document.getElementById('chapter-detail-title').textContent = newName;
          showToast('Chapter renamed');
        }
      }
    }

    this.closeModals();
  },

  handleDeleteProject() {
    if (!confirm('Are you sure you want to delete this project? All chapters and questions inside will be permanently deleted.')) return;
    
    state.data.projects = state.data.projects.filter(p => p.id !== state.activeProjectId);
    Storage.save();
    
    state.activeProjectId = null;
    this.showView('view-dashboard');
    this.renderDashboard();
    this.updateStats();
    showToast('Project deleted');
  },

  handleDeleteChapter() {
    if (!confirm('Are you sure you want to delete this chapter and all its questions?')) return;
    
    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    if (!project) return;

    project.chapters = project.chapters.filter(c => c.id !== state.activeChapterId);
    Storage.save();

    state.activeChapterId = null;
    this.openProject(project.id);
    this.updateStats();
    showToast('Chapter deleted');
  },

  // ==========================================
  // QUIZ ENGINE CORE
  // ==========================================
  openQuizSetup() {
    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    
    // Set headers
    document.getElementById('quiz-meta-title').textContent = `${project.name} / ${chapter.name}`;
    
    // Reset configuration settings state visibility
    document.getElementById('quiz-config-panel').style.display = 'block';
    document.getElementById('quiz-active-workspace').style.display = 'none';

    state.quiz.retakingWrongOnly = false;
    this.showView('view-quiz');
  },

  startQuizSession() {
    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    if (!chapter || chapter.questions.length === 0) return;

    // Load configurations from elements
    state.quiz.settings.timer = parseInt(document.getElementById('config-timer').value);
    state.quiz.settings.shuffle = document.getElementById('config-shuffle').checked;
    state.quiz.settings.mode = document.getElementById('config-mode').value;

    // Load active list of questions
    state.quiz.questions = [...chapter.questions];
    
    this.initializeQuizSequence();
  },

  startRetakeWrongOnly() {
    const project = state.data.projects.find(p => p.id === state.activeProjectId);
    const chapter = project.chapters.find(c => c.id === state.activeChapterId);
    if (!chapter) return;

    // Find wrong questions from previous quiz session
    const wrongQs = [];
    state.quiz.shuffledQuestions.forEach((q, idx) => {
      const userPick = state.quiz.answers[idx];
      if (userPick !== q.answer) {
        wrongQs.push(q);
      }
    });

    if (wrongQs.length === 0) {
      showToast('No wrong answers to retake!', 'warning');
      return;
    }

    state.quiz.questions = wrongQs;
    state.quiz.retakingWrongOnly = true;

    this.initializeQuizSequence();
  },

  initializeQuizSequence() {
    // Setup indexes
    state.quiz.currentIndex = 0;
    state.quiz.answers = {};
    state.quiz.startTime = Date.now();
    state.quiz.endTime = null;

    // Shuffling
    if (state.quiz.settings.shuffle) {
      state.quiz.shuffledQuestions = this.shuffleArray([...state.quiz.questions]);
    } else {
      state.quiz.shuffledQuestions = [...state.quiz.questions];
    }

    // Hide config page & show workspace
    document.getElementById('quiz-config-panel').style.display = 'none';
    document.getElementById('quiz-active-workspace').style.display = 'block';

    // Show timer bar if configured
    const timerDisplay = document.getElementById('quiz-timer-display');
    if (state.quiz.settings.timer > 0) {
      timerDisplay.style.display = 'flex';
    } else {
      timerDisplay.style.display = 'none';
    }

    this.renderQuestionCard();
  },

  shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  renderQuestionCard() {
    const q = state.quiz.shuffledQuestions[state.quiz.currentIndex];
    if (!q) return;

    // Reset controls
    this.stopQuizTimer();

    // Progress
    const total = state.quiz.shuffledQuestions.length;
    const progressPercent = ((state.quiz.currentIndex) / total) * 100;
    document.getElementById('quiz-progress-bar').style.style = `width: ${progressPercent}%`;
    document.getElementById('quiz-progress-bar').style.width = `${progressPercent}%`;
    document.getElementById('quiz-progress-text').textContent = `Question ${state.quiz.currentIndex + 1} of ${total}`;

    // Question Number & Text
    document.getElementById('quiz-question-number').textContent = `Question #${state.quiz.currentIndex + 1}`;
    document.getElementById('quiz-question-text').textContent = q.text;

    // Options Rendering
    const optionsContainer = document.getElementById('quiz-options-container');
    optionsContainer.innerHTML = '';

    q.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.innerHTML = `
        <span class="option-prefix">${String.fromCharCode(65 + idx)}</span>
        <span class="option-content">${this.escapeHTML(opt)}</span>
      `;
      btn.addEventListener('click', () => {
        this.selectAnswer(idx);
      });
      optionsContainer.appendChild(btn);
    });

    // Control visibility states
    document.getElementById('quiz-feedback-text').textContent = 'Select an option to lock in your answer.';
    document.getElementById('btn-next-question').style.display = 'none';
    document.getElementById('btn-submit-exam-answer').style.display = 'none';

    // Start timer if applicable
    if (state.quiz.settings.timer > 0) {
      this.startQuestionTimer();
    }
  },

  startQuestionTimer() {
    state.quiz.timeLeft = state.quiz.settings.timer;
    document.getElementById('timer-seconds').textContent = state.quiz.timeLeft;

    state.quiz.timerId = setInterval(() => {
      state.quiz.timeLeft--;
      document.getElementById('timer-seconds').textContent = state.quiz.timeLeft;

      if (state.quiz.timeLeft <= 0) {
        this.stopQuizTimer();
        showToast("Time's Up!", "warning");
        this.selectAnswer(-1); // Skipped or auto failed
      }
    }, 1000);
  },

  stopQuizTimer() {
    if (state.quiz.timerId) {
      clearInterval(state.quiz.timerId);
      state.quiz.timerId = null;
    }
  },

  selectAnswer(optionIdx) {
    this.stopQuizTimer();
    const q = state.quiz.shuffledQuestions[state.quiz.currentIndex];
    const isExamMode = state.quiz.settings.mode === 'exam';

    // Save selected answer index
    state.quiz.answers[state.quiz.currentIndex] = optionIdx;

    const optionButtons = document.querySelectorAll('#quiz-options-container .option-btn');

    if (isExamMode) {
      // --- EXAM MODE: let user change answer freely until they hit Submit ---
      // Clear any previous selection highlight
      optionButtons.forEach(btn => {
        btn.classList.remove('exam-selected');
      });

      // Highlight newly selected option (if not a timeout skip)
      if (optionIdx !== -1) {
        optionButtons[optionIdx].classList.add('exam-selected');
        document.getElementById('quiz-feedback-text').textContent = `Option ${String.fromCharCode(65 + optionIdx)} selected — tap another to change, or press Submit.`;
      }

      // Show Submit button (only after first selection)
      document.getElementById('btn-submit-exam-answer').style.display = 'inline-flex';

    } else {
      // --- QUIZ MODE: lock in answer immediately and reveal correct/wrong ---
      // Disable all options so they can't be changed
      optionButtons.forEach(btn => btn.setAttribute('disabled', 'true'));

      // Reveal right/wrong colours
      optionButtons.forEach((btn, idx) => {
        if (idx === q.answer) {
          btn.classList.add('reveal-correct');
        }
        if (idx === optionIdx) {
          if (optionIdx === q.answer) {
            btn.classList.add('selected-correct');
          } else {
            btn.classList.add('selected-wrong');
          }
        }
      });

      // Update feedback text
      if (optionIdx === q.answer) {
        document.getElementById('quiz-feedback-text').innerHTML = `<span class="color-success" style="font-weight:600;">Correct! Well done.</span>`;
      } else if (optionIdx === -1) {
        document.getElementById('quiz-feedback-text').innerHTML = `<span class="color-danger" style="font-weight:600;">Time's up! Correct answer: ${String.fromCharCode(65 + q.answer)}.</span>`;
      } else {
        document.getElementById('quiz-feedback-text').innerHTML = `<span class="color-danger" style="font-weight:600;">Incorrect. Correct answer: ${String.fromCharCode(65 + q.answer)}.</span>`;
      }

      document.getElementById('btn-next-question').style.display = 'inline-flex';
    }
  },


  nextQuestion() {
    state.quiz.currentIndex++;
    if (state.quiz.currentIndex < state.quiz.shuffledQuestions.length) {
      this.renderQuestionCard();
    } else {
      this.finishQuizSession();
    }
  },

  finishQuizSession() {
    state.quiz.endTime = Date.now();
    this.stopQuizTimer();
    
    // Fill the progress bar completely
    document.getElementById('quiz-progress-bar').style.width = '100%';

    // Calculate score
    let correct = 0;
    let wrong = 0;
    
    state.quiz.shuffledQuestions.forEach((q, idx) => {
      const userPick = state.quiz.answers[idx];
      if (userPick === q.answer) {
        correct++;
      } else {
        wrong++;
      }
    });

    const total = state.quiz.shuffledQuestions.length;
    const scorePercent = total > 0 ? Math.round((correct / total) * 100) : 0;
    const timeSpentSeconds = Math.round((state.quiz.endTime - state.quiz.startTime) / 1000);

    // Update UI Results Elements
    document.getElementById('results-percent').textContent = `${scorePercent}%`;
    document.getElementById('results-ratio').textContent = `${correct}/${total}`;
    document.getElementById('results-correct-count').textContent = correct;
    document.getElementById('results-wrong-count').textContent = wrong;
    document.getElementById('results-time-elapsed').textContent = formatTime(timeSpentSeconds);

    // Score radial ring fill
    // Circumference = 2 * PI * r = 2 * 3.14159 * 50 = 314
    const offset = 314 - (314 * scorePercent) / 100;
    const fillRing = document.getElementById('results-ring-fill');
    fillRing.setAttribute('stroke-dashoffset', offset);

    // Show/hide wrong-retake button depending if there are mistakes
    const retakeWrongBtn = document.getElementById('btn-retake-wrong');
    if (wrong > 0 && !state.quiz.retakingWrongOnly) {
      retakeWrongBtn.style.display = 'inline-flex';
    } else {
      retakeWrongBtn.style.display = 'none';
    }

    // Add to test history or upload to Firebase
    if (state.isParticipantMode && state.activeRoomId) {
      if (window.FirebaseConfig && window.FirebaseConfig.isInitialized()) {
        const dbObj = window.FirebaseConfig.getDb();
        dbObj.collection('rooms').doc(state.activeRoomId)
          .collection('submissions').add({
            nickname: state.participantName,
            correct: correct,
            total: total,
            percentage: scorePercent,
            timeSpent: timeSpentSeconds,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
          })
          .then(() => {
            showToast("Score successfully submitted to room leaderboard!");
          })
          .catch(err => {
            console.error("Error submitting score:", err);
            showToast("Failed to submit score to server.", "danger");
          });
      }
    } else {
      const project = state.data.projects.find(p => p.id === state.activeProjectId);
      const chapter = project.chapters.find(c => c.id === state.activeChapterId);
      if (project && chapter) {
        const historyEntry = {
          id: generateUUID(),
          timestamp: new Date().toISOString(),
          projectName: project.name,
          chapterName: chapter.name,
          correct: correct,
          total: total,
          percentage: scorePercent,
          timeSpent: timeSpentSeconds,
          mode: state.quiz.settings.mode
        };
        state.data.history.unshift(historyEntry);
        Storage.save();
      }
    }

    // Build answer review list
    this.renderQuizReviewList();

    this.showView('view-results');
  },

  renderQuizReviewList() {
    const list = document.getElementById('results-review-list');
    list.innerHTML = '';

    state.quiz.shuffledQuestions.forEach((q, idx) => {
      const userPick = state.quiz.answers[idx];
      const isCorrect = userPick === q.answer;

      const card = document.createElement('div');
      card.className = `review-item-card ${isCorrect ? 'correct-card' : 'wrong-card'}`;

      let optionsListHTML = '';
      q.options.forEach((opt, oIdx) => {
        let statusClass = '';
        if (oIdx === q.answer) {
          statusClass = 'correct-choice';
        } else if (oIdx === userPick) {
          statusClass = 'user-choice-wrong';
        }

        optionsListHTML += `
          <div class="review-option ${statusClass}">
            ${String.fromCharCode(65 + oIdx)}) ${this.escapeHTML(opt)}
          </div>
        `;
      });

      card.innerHTML = `
        <div class="review-q-text">${idx + 1}. ${this.escapeHTML(q.text)}</div>
        <div class="review-options-list">
          ${optionsListHTML}
        </div>
      `;

      list.appendChild(card);
    });
  },

  // ==========================================
  // EXPORT / IMPORT CONTROLLER
  // ==========================================
  showImportExportModal() {
    this.openModal('modal-import-export');
    document.getElementById('backup-file-input').value = '';
  },

  handleExportBackup() {
    const dataStr = JSON.stringify(state.data, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `quizforge-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    
    // Clean up
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 0);

    showToast('Backup downloaded successfully!');
  },

  handleImportBackup(file) {
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (parsed && Array.isArray(parsed.projects)) {
          // Merge or replace options
          if (confirm('Importing this file will merge it with your existing projects. Do you want to continue?')) {
            // Re-assign UUIDs if necessary to avoid collision or just append
            parsed.projects.forEach(newP => {
              // Simple check for collision
              const exists = state.data.projects.find(p => p.id === newP.id);
              if (exists) {
                newP.id = generateUUID(); // re-id to avoid collisions
              }
              state.data.projects.push(newP);
            });

            Storage.save();
            this.closeModals();
            this.renderDashboard();
            this.updateStats();
            showToast('Backup imported successfully!');
          }
        } else {
          showToast('Invalid backup file format.', 'danger');
        }
      } catch (err) {
        console.error(err);
        showToast('Failed to parse backup JSON file.', 'danger');
      }
    };
    reader.readAsText(file);
  },

  // ==========================================
  // MODAL UTILS
  // ==========================================
  openModal(modalId) {
    document.getElementById('modal-backdrop').classList.add('active');
    document.getElementById(modalId).classList.add('active');
  },

  closeModals() {
    document.getElementById('modal-backdrop').classList.remove('active');
    document.querySelectorAll('.modal').forEach(modal => {
      modal.classList.remove('active');
    });
  },

  // HTML Sanitizer to prevent XSS in pasted contents
  escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};

// Global initializer binding
window.addEventListener('DOMContentLoaded', () => {
  app.init();
});
window.app = app;
