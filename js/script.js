document.addEventListener('DOMContentLoaded', function() {
    // Set current year in footer
    document.getElementById('year').textContent = new Date().getFullYear();

    // Mobile menu toggle
    const hamburger = document.getElementById('hamburger');
    const navList = document.getElementById('nav-list');

    if (hamburger && navList) {
        hamburger.addEventListener('click', function() {
            this.classList.toggle('active');
            navList.classList.toggle('active');
        });
    }

    // Hero slider
    // Hero slider
const slides = document.querySelectorAll('.slide');
const dots = document.querySelectorAll('.dot');
const prevArrow = document.querySelector('.arrow-left');
const nextArrow = document.querySelector('.arrow-right');
let currentSlide = 0;
let slideInterval;

function showSlide(n) {
    slides.forEach(slide => slide.classList.remove('active'));
    dots.forEach(dot => dot.classList.remove('active'));
    
    currentSlide = (n + slides.length) % slides.length;
    slides[currentSlide].classList.add('active');
    dots[currentSlide].classList.add('active');
}

function nextSlide() {
    showSlide(currentSlide + 1);
}

function prevSlide() {
    showSlide(currentSlide - 1);
}

// Dot click event
dots.forEach(dot => {
    dot.addEventListener('click', function() {
        showSlide(parseInt(this.getAttribute('data-slide')));
        resetInterval();
    });
});

// Arrow click events
if (prevArrow) {
    prevArrow.addEventListener('click', () => {
        prevSlide();
        resetInterval();
    });
}

if (nextArrow) {
    nextArrow.addEventListener('click', () => {
        nextSlide();
        resetInterval();
    });
}

// Auto slide change
function startSlideShow() {
    slideInterval = setInterval(() => {
        nextSlide();
    }, 5000);
}

function resetInterval() {
    clearInterval(slideInterval);
    startSlideShow();
}

// Pause on hover
const heroSlider = document.querySelector('.hero-slider');
if (heroSlider) {
    heroSlider.addEventListener('mouseenter', () => clearInterval(slideInterval));
    heroSlider.addEventListener('mouseleave', () => startSlideShow());
}

// Start the slideshow
startSlideShow();

    // Testimonials slider
    const testimonials = document.querySelectorAll('.testimonial');
    const testimonialDots = document.querySelectorAll('.testimonial-dot');
    let currentTestimonial = 0;

    function showTestimonial(n) {
        testimonials.forEach(testimonial => testimonial.classList.remove('active'));
        testimonialDots.forEach(dot => dot.classList.remove('active'));
        
        currentTestimonial = (n + testimonials.length) % testimonials.length;
        testimonials[currentTestimonial].classList.add('active');
        testimonialDots[currentTestimonial].classList.add('active');
    }

    testimonialDots.forEach(dot => {
        dot.addEventListener('click', function() {
            showTestimonial(parseInt(this.getAttribute('data-testimonial')));
        });
    });

    // Auto testimonial change
    let testimonialInterval = setInterval(() => {
        showTestimonial(currentTestimonial + 1);
    }, 6000);

    // Awards slider
    const awards = document.querySelectorAll('.award');
    const awardDots = document.querySelectorAll('.award-dot');
    let currentAward = 0;

    if (awards.length > 0) {
        function showAward(n) {
            awards.forEach(award => award.classList.remove('active'));
            awardDots.forEach(dot => dot.classList.remove('active'));
            
            currentAward = (n + awards.length) % awards.length;
            awards[currentAward].classList.add('active');
            awardDots[currentAward].classList.add('active');
        }

        awardDots.forEach(dot => {
            dot.addEventListener('click', function() {
                showAward(parseInt(this.getAttribute('data-award')));
            });
        });

        // Auto award change
        let awardInterval = setInterval(() => {
            showAward(currentAward + 1);
        }, 5000);
    }

    // Services tabs
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    if (tabBtns.length > 0) {
        tabBtns.forEach(btn => {
            btn.addEventListener('click', function() {
                const tabId = this.getAttribute('data-tab');
                
                tabBtns.forEach(btn => btn.classList.remove('active'));
                tabPanes.forEach(pane => pane.classList.remove('active'));
                
                this.classList.add('active');
                document.getElementById(tabId).classList.add('active');
            });
        });
    }

    // Gallery filter
    const filterBtns = document.querySelectorAll('.filter-btn');
    const galleryItems = document.querySelectorAll('.gallery-item');

    if (filterBtns.length > 0) {
        filterBtns.forEach(btn => {
            btn.addEventListener('click', function() {
                const filter = this.getAttribute('data-filter');
                
                filterBtns.forEach(btn => btn.classList.remove('active'));
                this.classList.add('active');
                
                galleryItems.forEach(item => {
                    if (filter === 'all' || item.getAttribute('data-category') === filter) {
                        item.style.display = 'block';
                    } else {
                        item.style.display = 'none';
                    }
                });
            });
        });
    }

    // Gallery lightbox
    // Enhanced gallery script with video support
        document.addEventListener('DOMContentLoaded', function() {
            // Initialize lightbox
            const lightbox = document.getElementById('lightbox');
            const lightboxMedia = document.querySelectorAll('.lightbox-media');
            const lightboxImage = document.getElementById('lightbox-image');
            const lightboxVideo = document.getElementById('lightbox-video');
            const lightboxTitle = document.getElementById('lightbox-title');
            const lightboxDesc = document.getElementById('lightbox-description');
            const closeBtn = document.querySelector('.close-lightbox');
            const prevBtn = document.querySelector('.lightbox-prev');
            const nextBtn = document.querySelector('.lightbox-next');
            
            // Get all gallery items
            const galleryItems = document.querySelectorAll('.gallery-item');
            let currentIndex = 0;
            
            // Open lightbox
            function openLightbox(index) {
                currentIndex = index;
                const item = galleryItems[currentIndex];
                const media = item.querySelector('img, video');
                
                // Hide all media first
                lightboxMedia.forEach(m => m.style.display = 'none');
                
                if (media.tagName === 'IMG') {
                    lightboxImage.src = media.src;
                    lightboxImage.style.display = 'block';
                    lightboxVideo.pause();
                } else if (media.tagName === 'VIDEO') {
                    const source = media.querySelector('source');
                    lightboxVideo.querySelector('source').src = source.src;
                    lightboxVideo.load();
                    lightboxVideo.style.display = 'block';
                }
                
                const overlay = item.querySelector('.gallery-overlay');
                lightboxTitle.textContent = overlay.querySelector('h3').textContent;
                lightboxDesc.textContent = overlay.querySelector('p').textContent;
                
                lightbox.style.display = 'flex';
                document.body.style.overflow = 'hidden';
            }
            
            // Close lightbox
            function closeLightbox() {
                lightbox.style.display = 'none';
                document.body.style.overflow = 'auto';
                lightboxVideo.pause();
            }
            
            // Navigation
            function showPrev() {
                currentIndex = (currentIndex - 1 + galleryItems.length) % galleryItems.length;
                openLightbox(currentIndex);
            }
            
            function showNext() {
                currentIndex = (currentIndex + 1) % galleryItems.length;
                openLightbox(currentIndex);
            }
            
            // Event listeners
            galleryItems.forEach((item, index) => {
                item.addEventListener('click', () => openLightbox(index));
            });
            
            closeBtn.addEventListener('click', closeLightbox);
            prevBtn.addEventListener('click', showPrev);
            nextBtn.addEventListener('click', showNext);
            
            // Close when clicking outside content
            lightbox.addEventListener('click', function(e) {
                if (e.target === lightbox) {
                    closeLightbox();
                }
            });
            
            // Keyboard navigation
            document.addEventListener('keydown', function(e) {
                if (lightbox.style.display === 'flex') {
                    if (e.key === 'Escape') closeLightbox();
                    if (e.key === 'ArrowLeft') showPrev();
                    if (e.key === 'ArrowRight') showNext();
                }
            });
            
            // Filter functionality
            const filterButtons = document.querySelectorAll('.filter-btn');
            
            filterButtons.forEach(button => {
                button.addEventListener('click', function() {
                    // Update active button
                    filterButtons.forEach(btn => btn.classList.remove('active'));
                    this.classList.add('active');
                    
                    const filter = this.getAttribute('data-filter');
                    
                    galleryItems.forEach(item => {
                        if (filter === 'all' || item.getAttribute('data-category') === filter) {
                            item.style.display = 'block';
                        } else {
                            item.style.display = 'none';
                        }
                    });
                });
            });
        });

    // FAQ accordion
    const faqQuestions = document.querySelectorAll('.faq-question');

    faqQuestions.forEach(question => {
        question.addEventListener('click', function() {
            this.classList.toggle('active');
        });
    });

    // Contact form submission
    const contactForm = document.getElementById('contactForm');
    const formSuccess = document.getElementById('formSuccess');

    if (contactForm) {
        contactForm.addEventListener('submit', function(e) {
            e.preventDefault();
            
            // Here you would typically send the form data to a server
            // For demonstration, we'll just show the success message
            contactForm.style.display = 'none';
            formSuccess.style.display = 'block';
            
            // Reset form after 5 seconds
            setTimeout(() => {
                contactForm.style.display = 'grid';
                formSuccess.style.display = 'none';
                this.reset();
            }, 5000);
        });
    }

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                window.scrollTo({
                    top: targetElement.offsetTop - 70,
                    behavior: 'smooth'
                });
            }
        });
    });

    // WhatsApp Button Animation
    const whatsappBtn = document.querySelector('.whatsapp-btn');
    if (whatsappBtn) {
        window.addEventListener('scroll', function() {
            if (window.scrollY > 300) {
                whatsappBtn.style.opacity = '1';
                whatsappBtn.style.visibility = 'visible';
            } else {
                whatsappBtn.style.opacity = '0';
                whatsappBtn.style.visibility = 'hidden';
            }
        });
    }

    // Header scroll effect
    window.addEventListener('scroll', function() {
        const header = document.querySelector('.main-header');
        if (window.scrollY > 100) {
            header.style.boxShadow = '0 2px 20px rgba(0, 0, 0, 0.1)';
        } else {
            header.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.1)';
        }
    });

    // Intersection Observer for animations
    const animateElements = document.querySelectorAll('.feature-item, .team-member, .value-item, .offer-card, .method-card, .faq-item');
    
    const observerOptions = {
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate');
            }
        });
    }, observerOptions);

    animateElements.forEach(el => {
        observer.observe(el);
    });
});