(function () {
  "use strict";

  var prefersReduced = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  // --- Typewriter effect on hero headline ---
  var typewriterEl = document.querySelector("[data-typewriter]");
  if (typewriterEl) {
    var words = [
      "maintaining.",
      "inheriting.",
      "reading.",
      "owning.",
      "trusting.",
      "keeping.",
      "building."
    ];
    var wordIndex = 0;
    var charIndex = 0;
    var typeSpeed = 55;
    var deleteSpeed = 30;
    var pauseAfterType = 2800;
    var pauseAfterDelete = 300;

    typewriterEl.textContent = "";
    typewriterEl.style.visibility = "visible";

    if (prefersReduced) {
      typewriterEl.textContent = words[0];
      function cycleWord() {
        wordIndex = (wordIndex + 1) % words.length;
        typewriterEl.textContent = words[wordIndex];
        setTimeout(cycleWord, pauseAfterType);
      }
      setTimeout(cycleWord, pauseAfterType);
    } else {
      function typeWord() {
        var word = words[wordIndex];
        if (charIndex < word.length) {
          typewriterEl.textContent = word.substring(0, charIndex + 1);
          charIndex++;
          setTimeout(typeWord, typeSpeed);
        } else {
          setTimeout(deleteWord, pauseAfterType);
        }
      }

      function deleteWord() {
        if (charIndex > 0) {
          charIndex--;
          typewriterEl.textContent = words[wordIndex].substring(0, charIndex);
          setTimeout(deleteWord, deleteSpeed);
        } else {
          wordIndex = (wordIndex + 1) % words.length;
          setTimeout(typeWord, pauseAfterDelete);
        }
      }

      setTimeout(typeWord, 400);
    }
  }

  // --- Scroll-triggered reveals ---
  if (!prefersReduced) {
    var revealEls = document.querySelectorAll("[data-reveal]");
    if (revealEls.length && "IntersectionObserver" in window) {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("revealed");
              observer.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.1, rootMargin: "0px 0px -20px 0px" }
      );
      revealEls.forEach(function (el) {
        observer.observe(el);
      });
    } else if (revealEls.length) {
      revealEls.forEach(function (el) {
        el.classList.add("revealed");
      });
    }
  } else {
    var els = document.querySelectorAll("[data-reveal]");
    els.forEach(function (el) {
      el.classList.add("revealed");
    });
  }

  // --- Nav shadow on scroll ---
  var nav = document.querySelector(".nav");
  if (nav) {
    var scrolled = false;
    window.addEventListener(
      "scroll",
      function () {
        var shouldBeScrolled = window.scrollY > 20;
        if (shouldBeScrolled !== scrolled) {
          scrolled = shouldBeScrolled;
          nav.classList.toggle("nav-scrolled", scrolled);
        }
      },
      { passive: true }
    );
    if (window.scrollY > 20) {
      nav.classList.add("nav-scrolled");
    }
  }

  // --- Smooth FAQ expand/collapse ---
  var faqItems = document.querySelectorAll(".faq-item");
  faqItems.forEach(function (item) {
    var summary = item.querySelector("summary");
    var answer = item.querySelector(".faq-answer");
    if (!summary || !answer) return;

    summary.addEventListener("click", function (e) {
      e.preventDefault();
      if (item.open) {
        answer.style.maxHeight = answer.scrollHeight + "px";
        requestAnimationFrame(function () {
          answer.style.maxHeight = "0";
        });
        answer.addEventListener(
          "transitionend",
          function () {
            item.open = false;
            answer.style.maxHeight = "";
          },
          { once: true }
        );
      } else {
        item.open = true;
        var h = answer.scrollHeight;
        answer.style.maxHeight = "0";
        requestAnimationFrame(function () {
          answer.style.maxHeight = h + "px";
        });
        answer.addEventListener(
          "transitionend",
          function () {
            answer.style.maxHeight = "";
          },
          { once: true }
        );
      }
    });
  });
})();
