# VOR Simulator: Technical Specification & Implementation Guide

This document serves as the master blueprint for building a web-based, live-device-rotation-driven **Vestibular-Ocular Reflex (VOR) Simulator**. It is designed to be digested by **Claude Code** to transform your existing asset framework from a gravity-driven particle-tracking system (BPPV simulator) into a true dynamic angular VOR model.

---

## 1. Project Overview & Objectives

*   **Goal:** Create a freely accessible, open-source web application (similar to the iOS-only `aVOR` app) that demonstrates how head movements trigger relative endolymph fluid movement, subsequent cupular deflection, neural firing rate asymmetries, and the resulting eye movements (nystagmus).
*   **Asset Reuse:** Leverage the 3D inner ear and eye meshes from the existing `jakalnz/bppv-simulator`.
*   **Primary Input:** Live mobile/tablet device gyroscopes (`DeviceMotionEvent` and `DeviceOrientationEvent`).
*   **Secondary Input:** Manual screen-drag interactions for desktop users.
*   **Visual Output:** Dynamic color shifts in the semicircular canals reflecting excitation/inhibition, accompanied by real-time mathematical driving of the extraocular eye meshes.

---

## 2. Mathematical & Physiological Pipeline

The core engine operates as a unidirectional feed-forward pipeline executing on every animation frame ($\Delta t$):

```
[Device Gyroscope (Angular Velocity)] 
                 ↓
   [Vector Projection onto Canals] 
                 ↓
  [Fluid Inertia / Cupula Deflection] 
                 ↓
[Neural Firing Engine (Ewald's Laws)] 
                 ↓
 [Eye Mechanics & Nystagmus Machine]
```

### 2.1 Vector Projection (Head to Canal Planes)
The three pairs of semicircular canals function as orthogonal coordinate systems, but they are tilted relative to the standard anatomical axes of the head. We define each canal by its 3D unit normal vector $\hat{n}$ in the local head coordinate system:

*   **Left Horizontal (LH) / Right Horizontal (RH):** Primarily respond to Yaw (Z-axis).
*   **LARP Pair:** Left Anterior (LA) and Right Posterior (RP) plane.
*   **RALP Pair:** Right Anterior (RA) and Left Posterior (LP) plane.

For a raw head angular velocity vector $ec{\omega} = [\omega_x, \omega_y, \omega_z]^T$ derived from the gyroscope, the directional stimulation $\omega_{	ext{canal}}$ for any given canal is calculated via the dot product:

$$\omega_{	ext{canal}} = ec{\omega} \cdot \hat{n}_{	ext{canal}}$$

### 2.2 Fluid Dynamics & Cupular Deflection
Instead of updating particles with acceleration vectors, model the fluid/cupula system as a heavily damped torsion pendulum (the Steinhausen model). For real-time execution, this can be implemented as a discrete high-pass filter where fluid displacement ($c$) decays back to zero during constant velocity with a biological time constant $	au pprox 6.0$ seconds:

$$c_{t} = c_{t-\Delta t} \cdot \left(1 - rac{\Delta t}{	au}ight) + \omega_{	ext{canal}} \cdot \Delta t$$

### 2.3 Neural Firing Engine & Ewald's Laws
Each vestibular nerve possesses a baseline resting firing rate of $\sim 90	ext{ spikes/sec}$ (Hz). Cupular deflection ($c$) modulates this rate up or down:

*   **Horizontal Canals:** Ampullopetal fluid movement (towards the ampulla) increases firing rate (**Excitation**); ampullofugal movement decreases it (**Inhibition**).
*   **Vertical Canals (Anterior/Posterior):** The rule is reversed: ampullofugal movement is excitatory, ampullopetal is inhibitory.
*   **Ewald's Second Law Constraint:** Firing rates cannot drop below $0	ext{ Hz}$ (saturation/cutoff), but can expand up to $\sim 400	ext{ Hz}$. This fundamental asymmetry must be strictly enforced:

$$f_{	ext{canal}} = \max(0, f_{	ext{rest}} + k \cdot c_{t})$$

### 2.4 Eye Mechanics & Nystagmus State Machine
The brainstem computes differences between functional pairs to command extraocular eye movements. 
*   **Horizontal Pair Delta:** $\Delta f_{	ext{Horiz}} = f_{	ext{LH}} - f_{	ext{RH}}$
*   **Slow-Phase Velocity (SPV):** The eye tracks smoothly in the opposite direction of head rotation to maintain gaze fixation. The velocity of this drift is directly proportional to $\Delta f$.
*   **Fast-Phase Reset (Saccade):** If eye displacement exceeds a mechanical threshold (e.g., $\pm 15^\circ$ or $\pm 0.26	ext{ radians}$), the system triggers an instantaneous fast-phase snapback in the opposite direction (towards the more active side) before resuming slow-phase tracking.

---

## 3. Web API & Data Capture Implementation

### 3.1 Gyroscopic Inputs (DeviceMotion)
To pull real-time rotational rates from the device hardware:

```javascript
export class VestibularInputManager {
    constructor() {
        this.angularVelocity = new THREE.Vector3();
        this.orientation = new THREE.Euler();
        this.isReady = false;
    }

    async initialize() {
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceMotionEvent.requestPermission();
                if (permission === 'granted') {
                    this.bindEvents();
                }
            } catch (err) {
                console.error("Device motion permission denied:", err);
            }
        } else {
            this.bindEvents();
        }
    }

    bindEvents() {
        window.addEventListener('devicemotion', (e) => {
            if (!e.rotationRate) return;
            const toRad = Math.PI / 180;
            // Capture raw angular velocities (deg/s -> rad/s)
            this.angularVelocity.set(
                (e.rotationRate.beta || 0) * toRad,  // Pitch (X)
                (e.rotationRate.gamma || 0) * toRad, // Roll (Y)
                (e.rotationRate.alpha || 0) * toRad  // Yaw (Z)
            );
        });

        window.addEventListener('deviceorientation', (e) => {
            const toRad = Math.PI / 180;
            // Capture absolute orientation for matching scene rotation
            this.orientation.set(
                (e.beta || 0) * toRad,
                (e.alpha || 0) * toRad,
                -(e.gamma || 0) * toRad,
                'YXZ'
            );
            this.isReady = true;
        });
    }
}
```

---

## 4. Three.js Mesh Integration Strategy

To overlay this logic on your existing visual asset, target sub-meshes within your loaded GLTF/OBJ model group.

### 4.1 Canal Mesh Mapping & Identification
During asset load traversal, bind individual mesh elements to your functional tracking loops:

```javascript
const canalMeshes = {
    LH: null, RH: null,
    LA: null, RP: null,
    RA: null, LP: null
};

loadedAssetGroup.traverse((child) => {
    if (child.isMesh) {
        // Replace string identifiers with your exact asset names
        if (child.name.includes("Horizontal_L")) canalMeshes.LH = child;
        if (child.name.includes("Horizontal_R")) canalMeshes.RH = child;
        if (child.name.includes("Anterior_L"))   canalMeshes.LA = child;
        if (child.name.includes("Posterior_R"))  canalMeshes.RP = child;
        if (child.name.includes("Anterior_R"))   canalMeshes.RA = child;
        if (child.name.includes("Posterior_L"))  canalMeshes.LP = child;
    }
});
```

### 4.2 Dynamic Color/Activity Feedback
Instead of renderable particle components, mutate the Material colors of the existing canal surfaces to convey biological neural signals:

```javascript
function updateCanalVisuals(mesh, firingRate) {
    if (!mesh) return;
    
    const baseline = 90;
    const maxExcitation = 250;
    
    // Normalize state between 0.0 (fully inhibited) and 1.0 (fully excited)
    let factor = (firingRate - 0) / maxExcitation;
    factor = Math.max(0, Math.min(1, factor));

    // Interpolate colors: Excited = Red, Inhibited = Blue, Rest = Muted Grey/Blue
    // Use Three.js Color.lerp for seamless transitions
    const colorInhibited = new THREE.Color(0x1a5fb4); // Deep blue
    const colorRest = new THREE.Color(0x787878);      // Neutral grey
    const colorExcited = new THREE.Color(0xe01b24);   // Vibrant red

    if (firingRate >= baseline) {
        let t = (firingRate - baseline) / (maxExcitation - baseline);
        mesh.material.color.copy(colorRest).lerp(colorExcited, Math.min(1, t));
    } else {
        let t = (baseline - firingRate) / baseline;
        mesh.material.color.copy(colorRest).lerp(colorInhibited, Math.min(1, t));
    }
}
```

### 4.3 Driving Eye Movements (Nystagmus Execution)
Bind your calculated horizontal, vertical, and torsional tracking angles to your existing eye sphere sub-meshes:

```javascript
class NystagmusEngine {
    constructor() {
        this.eyeAngle = new THREE.Vector3(0, 0, 0); // X: Vertical, Y: Horizontal, Z: Torsional
        this.threshold = 0.26; // ~15 degrees max deviation
    }

    update(deltaFiringHoriz, deltaFiringVert, dt) {
        const gain = 0.002; // Tune scalar for biological accuracy

        // 1. Slow Phase Gaze Drift (Opposite to head rotation direction)
        this.eyeAngle.y -= deltaFiringHoriz * gain * dt;
        this.eyeAngle.x -= deltaFiringVert * gain * dt;

        // 2. Fast Phase Reset State Machine
        if (Math.abs(this.eyeAngle.y) > this.threshold) {
            // Snap back instantly to opposite target boundary
            this.eyeAngle.y = -Math.sign(this.eyeAngle.y) * (this.threshold * 0.2);
        }
        if (Math.abs(this.eyeAngle.x) > this.threshold) {
            this.eyeAngle.x = -Math.sign(this.eyeAngle.x) * (this.threshold * 0.2);
        }

        // 3. Apply Local Rotations to Assets
        if (leftEyeMesh && rightEyeMesh) {
            leftEyeMesh.rotation.set(this.eyeAngle.x, this.eyeAngle.y, this.eyeAngle.z, 'XYZ');
            rightEyeMesh.rotation.set(this.eyeAngle.x, this.eyeAngle.y, this.eyeAngle.z, 'XYZ');
        }
    }
}
```

---

## 5. Architectural Guide for Claude Code

When prompting **Claude Code** inside your repository to write this new application, execute the following implementation workflow:

1.  **Isolate Engine Files:** Separate the core physiological state machines into a standalone file (e.g., `VorEngine.js`) so that it can be unit tested independently of Three.js.
2.  **Asset Layer Decoupling:** Keep your loader configurations from `jakalnz/bppv-simulator` intact but strip out particle simulation elements (`ParticleSystem`, gravimetric vectors, etc.). Replace them with the `VestibularInputManager` vectors.
3.  **Frame Loop Insertion:** Inside the standard `requestAnimationFrame` loop, inject the calculation pass: Read Gyro -> Project -> Filter Cupula -> Modify Firing Rates -> Update Mesh Colors -> Calculate Gaze Vector -> Apply Eye Rotation.
4.  **UI Controls Toggle:** Add a dual-mode control panel to alternate between device mirroring (`deviceorientation`) and manual fallback interaction (e.g., mouse pointer velocity calculations).
