const selectors = {
  loader: "[data-loader]",
  navbar: "[data-navbar]",
  cursorGlow: "[data-cursor-glow]",
  particles: "[data-particles]",
  tiltZone: "[data-tilt-zone]",
  tiltCard: "[data-tilt-card]",
  projectsStack: "#projectsStack",
  projectsStatus: "#projectsStatus",
  modal: "#projectModal",
  modalContent: "#modalContent",
  closeModal: "[data-close-modal]",
};

const state = {
  projects: [],
  mouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
};

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const textOrFallback = (value, fallback) => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
};

const makeElement = (tagName, options = {}) => {
  const element = document.createElement(tagName);
  if (options.className) element.className = options.className;
  if (options.text) element.textContent = options.text;
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([key, value]) => element.setAttribute(key, value));
  }
  return element;
};

const getInitials = (title) =>
  title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");

const normalizeProject = (project) => ({
  title: textOrFallback(project.title, "Untitled Project"),
  description: textOrFallback(project.description, "No description added yet."),
  image: textOrFallback(project.image, ""),
  techStack: Array.isArray(project.techStack)
    ? project.techStack.map((tech) => String(tech).trim()).filter(Boolean)
    : [],
  github: textOrFallback(project.github, ""),
  demo: textOrFallback(project.demo, ""),
});

const createImageBlock = (project, className = "project-media") => {
  const media = makeElement("div", { className });
  const fallback = makeElement("span", {
    className: "project-fallback",
    text: getInitials(project.title),
  });

  if (!project.image) {
    media.append(fallback);
    return media;
  }

  const image = makeElement("img", {
    attributes: {
      src: project.image,
      alt: `${project.title} preview`,
      loading: "lazy",
      decoding: "async",
    },
  });

  image.addEventListener("error", () => {
    image.remove();
    media.append(fallback);
  });

  media.append(image);
  return media;
};

const createTechList = (items, className = "tech-list") => {
  const list = makeElement("div", { className });
  items.forEach((item) => list.append(makeElement("span", { text: item })));
  return list;
};

const createActionLink = (href, label, style = "secondary") => {
  const link = makeElement("a", {
    className: `button ${style}`,
    text: label,
    attributes: { href, target: "_blank", rel: "noreferrer" },
  });
  return link;
};

const openProjectModal = (project) => {
  const modal = $(selectors.modal);
  const modalContent = $(selectors.modalContent);
  modalContent.replaceChildren();

  const body = makeElement("div", { className: "modal-body" });
  body.append(
    makeElement("h2", { text: project.title, attributes: { id: "modalTitle" } }),
    makeElement("p", { text: project.description }),
    createTechList(project.techStack, "modal-tech"),
  );

  const actions = makeElement("div", { className: "modal-actions" });
  if (project.github) actions.append(createActionLink(project.github, "Open GitHub"));
  if (project.demo) actions.append(createActionLink(project.demo, "Open Live Demo", "primary"));
  body.append(actions);

  modalContent.append(createImageBlock(project, "modal-hero"), body);
  document.body.classList.add("modal-open");
  modal.showModal();
};

const createProjectCard = (project, index) => {
  const card = makeElement("article", {
    className: "project-card reveal",
    attributes: {
      tabindex: "0",
      role: "button",
      "aria-label": `Open ${project.title} project details`,
    },
  });
  card.style.zIndex = String(index + 1);

  const content = makeElement("div", { className: "project-content" });
  const actions = makeElement("div", { className: "project-actions" });
  if (project.github) actions.append(createActionLink(project.github, "GitHub"));
  if (project.demo) actions.append(createActionLink(project.demo, "Live Demo", "primary"));

  content.append(
    makeElement("h3", { text: project.title }),
    makeElement("p", { className: "project-copy", text: project.description }),
    createTechList(project.techStack),
    actions,
  );

  card.append(createImageBlock(project), content);
  card.addEventListener("click", (event) => {
    if (event.target.closest("a")) return;
    openProjectModal(project);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openProjectModal(project);
    }
  });

  return card;
};

const renderProjects = (projects) => {
  const stack = $(selectors.projectsStack);
  const status = $(selectors.projectsStatus);
  stack.replaceChildren();

  if (!projects.length) {
    status.textContent = "No completed projects found in /data/projects.json.";
    return;
  }

  projects.forEach((project, index) => stack.append(createProjectCard(project, index)));
  status.textContent = "";
  observeReveals();
};

const loadProjects = async () => {
  try {
    const response = await fetch("./data/projects.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Project file returned ${response.status}`);
    const projects = await response.json();
    if (!Array.isArray(projects)) throw new Error("projects.json must contain an array.");

    state.projects = projects.map(normalizeProject);
    renderProjects(state.projects);
  } catch (error) {
    $(selectors.projectsStatus).textContent = "Projects could not be loaded. Check /data/projects.json.";
    console.error(error);
  }
};

let revealObserver;
const observeReveals = () => {
  revealObserver?.disconnect();
  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add("is-visible");
      });
    },
    { threshold: 0.16 },
  );
  $$(".reveal").forEach((element) => revealObserver.observe(element));
};

const setupNavbar = () => {
  const navbar = $(selectors.navbar);
  const updateNavbar = () => navbar.classList.toggle("is-scrolled", window.scrollY > 18);
  updateNavbar();
  window.addEventListener("scroll", updateNavbar, { passive: true });
};

const setupCursorGlow = () => {
  const glow = $(selectors.cursorGlow);
  if (!glow || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  window.addEventListener(
    "pointermove",
    (event) => {
      state.mouse.x = event.clientX;
      state.mouse.y = event.clientY;
      glow.style.left = `${event.clientX}px`;
      glow.style.top = `${event.clientY}px`;
    },
    { passive: true },
  );
};

const setupTiltCards = () => {
  const zone = $(selectors.tiltZone);
  if (!zone || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  zone.addEventListener("pointermove", (event) => {
    const rect = zone.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;

    $$(selectors.tiltCard, zone).forEach((card, index) => {
      const depth = (index + 1) * 7;
      card.style.translate = `${x * depth}px ${y * depth}px`;
      card.style.rotate = `${-y * 4}deg ${x * 5}deg`;
    });
  });

  zone.addEventListener("pointerleave", () => {
    $$(selectors.tiltCard, zone).forEach((card) => {
      card.style.translate = "0 0";
      card.style.rotate = "0deg 0deg";
    });
  });
};

const setupParticles = () => {
  const canvas = $(selectors.particles);
  const context = canvas?.getContext("2d");
  if (!canvas || !context || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const particles = Array.from({ length: 58 }, () => ({
    x: Math.random(),
    y: Math.random(),
    size: Math.random() * 1.8 + 0.4,
    speed: Math.random() * 0.16 + 0.05,
  }));

  const resize = () => {
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
  };

  const draw = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(255, 255, 255, 0.28)";

    particles.forEach((particle) => {
      particle.y -= particle.speed / window.innerHeight;
      if (particle.y < -0.02) particle.y = 1.02;

      const x = particle.x * canvas.width;
      const y = particle.y * canvas.height;
      context.beginPath();
      context.arc(x, y, particle.size * window.devicePixelRatio, 0, Math.PI * 2);
      context.fill();
    });

    requestAnimationFrame(draw);
  };

  resize();
  draw();
  window.addEventListener("resize", resize, { passive: true });
};

const setupModal = () => {
  const modal = $(selectors.modal);
  $(selectors.closeModal).addEventListener("click", () => modal.close());
  modal.addEventListener("close", () => document.body.classList.remove("modal-open"));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.close();
  });
};

const hideLoader = () => {
  window.addEventListener("load", () => {
    setTimeout(() => $(selectors.loader)?.classList.add("is-hidden"), 280);
  });
};

hideLoader();
setupNavbar();
setupCursorGlow();
setupTiltCards();
setupParticles();
setupModal();
observeReveals();
loadProjects();
