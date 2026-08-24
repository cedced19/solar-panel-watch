// Header navigation: shows a Home link and a contextual "Back" button.
// The Back button only appears when there is navigation depth (a previous page
// in the history, or an in-app referrer) so it is hidden on direct arrival.
(function () {
    var backBtn = document.getElementById('nav-back');

    if (backBtn) {
        var canGoBack = window.history.length > 1;
        if (!canGoBack && document.referrer &&
            document.referrer.indexOf(window.location.origin) === 0) {
            canGoBack = true;
        }
        if (!canGoBack) {
            backBtn.hidden = true;
        }
        backBtn.addEventListener('click', function (e) {
            e.preventDefault();
            window.history.back();
        });
    }
})();
