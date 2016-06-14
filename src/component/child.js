
import postRobot from 'post-robot/src';
import { SyncPromise as Promise } from 'sync-browser-mocks/src/promise';
import { BaseComponent } from './base';
import { parseWindowName } from './util';
import { noop, extend, getParentWindow, onCloseWindow } from '../lib';
import { CONSTANTS } from '../constants';

/*  Child Component
    ---------------

    This is the portion of code which runs inside the frame or popup window containing the component's implementation.

    When the component author calls myComponent.attach(), it creates a new instance of ChildComponent, which is then
    responsible for managing the state and messaging back up to the parent, and providing props for the component to
    utilize.
*/

export class ChildComponent extends BaseComponent {

    constructor(component, options = {}) {
        super(component, options);
        this.component = component;

        this.validate(options);

        // Handlers for various component lifecycle events

        this.onEnter = this.tryCatch(options.onEnter || noop);
        this.onClose = this.tryCatch(options.onClose || noop);
        this.onError = this.tryCatch(options.onError || function(err) { throw err; });
        this.onProps = this.tryCatch(options.onProps || noop, false);

        // The child can specify some default props if none are passed from the parent. This often makes integrations
        // a little more seamless, as applicaiton code can call props.foo() without worrying about whether the parent
        // has provided them or not, and fall-back to some default behavior.

        this.props = options.defaultProps || {};

        // We support a 'standalone' mode where the child isn't actually created by xcomponent. This may be because
        // there's an existing full-page implementation which uses redirects. In this case, the user can specify
        // standalone: true, and defaultProps, and the child component should continue to function in the same way
        // as if it were created by xcomponent, with the exception that no post-messages will ever be sent.

        this.standalone = options.standalone;

        // In standalone mode, we would expect setWindows to fail since there is no parent window and window.name
        // will not be generated by xcomponent. In this case we can fail silently, whereas normally we'd want to
        // fail hard here.

        try {
            this.setWindows();
        } catch (err) {

            if (this.standalone) {
                return;
            }

            throw err;
        }
    }

    /*  Init
        ----

        Message up to the parent to let them know we've rendered successfully, and get some initial data and props
    */

    init() {

        // In standalone mode, there's no point messaging back up to our parent -- because we have none. :'(

        if (this.standalone && !this.parentComponentWindow) {
            return Promise.resolve();
        }

        // Start listening for post messages

        this.listen(this.parentComponentWindow);
        if (this.parentWindow !== this.parentComponentWindow) {
            this.listen(this.parentWindow);
        }

        // Send an init message to our parent. This gives us an initial set of data to use that we can use to function.
        //
        // For example:
        //
        // - What context are we
        // - What props has the parent specified

        return this.sendToParentComponent(CONSTANTS.POST_MESSAGE.INIT).then(data => {

            this.context = data.context;
            extend(this.props, data.props);

            this.onEnter.call(this);
            this.onProps.call(this);

        }).catch(err => this.onError(err));
    }


    /*  Send to Parent
        --------------

        Send a post message to our parent component window. Note -- this may not be our immediate parent, if we were
        rendered using renderToParent.
    */

    sendToParentComponent(name, data) {
        return postRobot.send(this.parentComponentWindow, name, data);
    }


    /*  Set Windows
        -----------

        Determine the parent window, and the parent component window. Note -- these may be different, if we were
        rendered using renderToParent.
    */

    setWindows() {


        // Ensure we do not try to .attach() multiple times for the same component on the same page

        if (window.__activeXComponent__) {
            throw new Error(`[${this.component.tag}] Can not attach multiple components to the same window`);
        }

        window.__activeXComponent__ = this;

        // Get the direct parent window

        this.parentWindow = getParentWindow();

        if (!this.parentWindow) {
            throw new Error(`[${this.component.tag}] Can not find parent window`);
        }

        // Get properties from the window name, passed down from our parent component

        let winProps = parseWindowName(window.name);

        if (!winProps) {
            throw new Error(`[${this.component.tag}] Window has not been rendered by xcomponent - can not attach here`);
        }

        // Use this to infer which window is our true 'parent component'. This can either be:
        //
        // - Our actual parent
        // - A sibling which rendered us using renderToParent()

        if (winProps.sibling) {

            // We were rendered by a sibling, which we can access cross-domain via parent.frames
            this.parentComponentWindow = this.parentWindow.frames[winProps.parent];

        } else {

            // Our parent window is the same as our parent component window
            this.parentComponentWindow = this.parentWindow;
        }

        // Note -- getting references to other windows is probably one of the hardest things to do. There's basically
        // only a few ways of doing it:
        //
        // - The window is a direct parent, in which case you can use window.parent or window.opener
        // - The window is an iframe owned by you or one of your parents, in which case you can use window.frames
        // - The window sent you a post-message, in which case you can use event.source
        //
        // If we didn't rely on winProps.parent here from the window name, we'd have to relay all of our messages through
        // our actual parent. Which is no fun at all, and pretty error prone even with the help of post-robot. So this
        // is the lesser of two evils until browsers give us something like getWindowByName(...)

        // If the parent window closes, we need to close ourselves. There's no point continuing to run our component
        // if there's no parent to message to.

        this.watchForClose();
    }


    /*  Watch For Close
        ---------------

        Watch both the parent window and the parent component window, if they close, close this window too.
    */

    watchForClose() {

        onCloseWindow(this.parentWindow, () => {
            this.onClose(new Error(`[${this.component.tag}] parent window was closed`));

            // We only need to close ourselves if we're a popup -- otherwise our parent window closing will automatically
            // close us, if we're an iframe

            if (this.context === CONSTANTS.CONTEXT.POPUP) {
                window.close();
            }
        });

        // Only listen for parent component window if it's actually a different window

        if (this.parentComponentWindow && this.parentComponentWindow !== this.parentWindow) {
            onCloseWindow(this.parentComponentWindow, () => {

                // We do actually need to close ourselves in this case, even if we're an iframe, because our component
                // window is probably a sibling and we'll remain open by default.

                this.close(new Error(`[${this.component.tag}] parent component window was closed`));
            });
        }
    }


    /*  Validate
        --------

        Validate any options passed in to ChildComponent
    */

    validate(options) {

        // TODO: Implement this
    }


    /*  Listeners
        ---------

        Post-message listeners that will be automatically set up to listen for messages from the parent component
    */

    listeners() {
        return {

            // New props are being passed down

            [ CONSTANTS.POST_MESSAGE.PROPS ](source, data) {
                extend(this.props, data.props);
                this.onProps.call(this);
            },

            // The parent wants us to close.

            [ CONSTANTS.POST_MESSAGE.CLOSE ](source, data) {

                // If source is not our immediate parent, we need to message our parent window to tell it to close us.

                if (source !== this.parentWindow) {
                    postRobot.sendToParent(CONSTANTS.POST_MESSAGE.CLOSE);

                    // Note -- we don't want to wait for that post message, otherwise we'll be closed before we can
                    // respond to the original close message

                    return;
                }

                // Otherwise call onClose and allow the parent to close us

                this.onClose.call(this);
            }
        };
    }


    /*  Close
        -----

        Close the child window
    */

    close(err) {

        this.onClose.call(this, err);

        // We could do this ourselves, if we were a popup -- but iframes can't close themselves, so in all cases just
        // message the parent and have them close us instead

        return postRobot.sendToParent(CONSTANTS.POST_MESSAGE.CLOSE);
    }


    /*  Focus
        -----

        Focus the child window. Must be done on a user action like a click
    */

    focus() {
        window.focus();
    }


    /*  Resize
        -----

        Resize the child window. Must be done on a user action like a click
    */

    resize(width, height) {
        window.resizeTo(width, height);
    }


    /*  Redirect To Parent
        ------------------

        Redirect the parent window
     */

    redirectParent(url) {

        // TODO: Implement this. Or don't. Not sure if it's a good idea when it's easy enough to do with props...
    }


    /*  Break Out
        ---------

        Redirect the parent window to the current url, effectively breaking the component out to the full page
    */

    breakOut() {
        this.redirectParent(window.location.href);
    }


    /*  Error
        -----

        Send an error back to the parent
    */

    error(err) {
        return this.sendToParentComponent(CONSTANTS.POST_MESSAGE.ERROR, {
            error: err.stack ? `${err.message}\n${err.stack}` : err.toString()
        });
    }
}
